//! Remembers the main window's size, position and maximized state between
//! launches.
//!
//! The size is kept in logical points and handed to the window builder, so
//! the OS applies it at the right scale. Restoring physical pixels right after
//! the window is created is unreliable on macOS: the window does not know its
//! screen's scale factor yet, so Retina displays get the window at twice its
//! size, and that size is then saved again.
//!
//! Positions are kept in the desktop's own coordinate space: logical points on
//! macOS, which lays out all screens in points, and physical pixels elsewhere,
//! where screens with different scales share one pixel space.

use std::{fs, path::PathBuf, sync::Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Monitor, PhysicalPosition, Runtime, Window};

const FILE_NAME: &str = "window-state.json";

/// The window's last size, in logical points, and position, in desktop
/// coordinates (see [`desktop_position`]).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub maximized: bool,
}

/// A screen's area in desktop coordinates.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Area {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    /// Points to desktop units: the screen's scale factor outside macOS, 1 on
    /// macOS, whose desktop is laid out in points.
    pub scale: f64,
}

impl Area {
    fn of(monitor: &Monitor) -> Self {
        let scale = monitor.scale_factor();
        let (x, y) = desktop_position(*monitor.position(), scale);
        let size = monitor.size();
        let (width, height) = if cfg!(target_os = "macos") {
            let size = size.to_logical::<f64>(scale);
            (size.width, size.height)
        } else {
            (f64::from(size.width), f64::from(size.height))
        };
        Self {
            x,
            y,
            width,
            height,
            scale: if cfg!(target_os = "macos") {
                1.0
            } else {
                scale
            },
        }
    }
}

/// A position in the desktop's coordinate space. macOS reports screens and
/// windows in points scaled by their own screen's factor, so dividing by that
/// factor gives back the points it lays the desktop out in.
fn desktop_position(position: PhysicalPosition<i32>, scale: f64) -> (f64, f64) {
    if cfg!(target_os = "macos") {
        let position = position.to_logical::<f64>(scale);
        (position.x, position.y)
    } else {
        (f64::from(position.x), f64::from(position.y))
    }
}

/// Moves a window being built to a saved position. On macOS the builder takes
/// desktop points directly; elsewhere the window is created hidden and moved
/// in physical pixels, which every screen shares, before it is shown.
pub fn position_builder<'a, R: Runtime, M: Manager<R>>(
    builder: tauri::webview::WebviewWindowBuilder<'a, R, M>,
    bounds: &Bounds,
) -> tauri::webview::WebviewWindowBuilder<'a, R, M> {
    if cfg!(target_os = "macos") {
        builder.position(bounds.x, bounds.y)
    } else {
        builder.visible(false)
    }
}

/// Finishes [`position_builder`] once the window exists.
pub fn position_window<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
    bounds: &Bounds,
) -> tauri::Result<()> {
    if !cfg!(target_os = "macos") {
        // Rounded: saved values came from whole pixels.
        let _ = window.set_position(PhysicalPosition::new(
            bounds.x.round() as i32,
            bounds.y.round() as i32,
        ));
        // Moving a window un-maximizes it, so maximize it again afterwards:
        // it then un-maximizes back to this position.
        if bounds.maximized {
            window.maximize()?;
        }
        window.show()?;
    }
    Ok(())
}

/// How much of the window's title bar area must be on a screen to keep the
/// saved position, so the window can still be dragged.
const MIN_VISIBLE: f64 = 64.0;

impl Bounds {
    /// Whether the saved values are usable at all.
    fn is_sane(&self, min_width: f64, min_height: f64) -> bool {
        let finite = [self.x, self.y, self.width, self.height]
            .iter()
            .all(|v| v.is_finite());
        finite
            && (min_width..=100_000.0).contains(&self.width)
            && (min_height..=100_000.0).contains(&self.height)
    }

    /// Centers the window on `screen` unless its middle is already there.
    pub fn move_onto(&mut self, screen: &Area) {
        let middle_x = self.x + self.width * screen.scale / 2.0;
        let middle_y = self.y + self.height * screen.scale / 2.0;
        if (screen.x..screen.x + screen.width).contains(&middle_x)
            && (screen.y..screen.y + screen.height).contains(&middle_y)
        {
            return;
        }
        self.x = screen.x + ((screen.width - self.width * screen.scale) / 2.0).max(0.0);
        self.y = screen.y + ((screen.height - self.height * screen.scale) / 2.0).max(0.0);
    }

    /// Whether enough of the window's top edge is on one of `screens`. On macOS
    /// the position is the content area's, just below the title bar.
    pub fn is_visible_on(&self, screens: &[Area]) -> bool {
        screens.iter().any(|s| {
            let left = self.x.max(s.x);
            // The window's width in this screen's units, at its current scale.
            let right = (self.x + self.width * s.scale).min(s.x + s.width);
            let top_on_screen = self.y >= s.y && self.y < s.y + s.height - MIN_VISIBLE / 2.0;
            right - left >= MIN_VISIBLE && top_on_screen
        })
    }
}

/// The bounds saved while the app runs, written to disk on exit. It starts
/// from the saved bounds, so quitting while still maximized keeps them.
pub struct Tracker(Mutex<Option<Bounds>>);

impl Tracker {
    pub fn new(initial: Option<Bounds>) -> Self {
        Self(Mutex::new(initial))
    }
}

fn file<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join(FILE_NAME))
}

/// The saved bounds, if any, that are sane and still on a connected screen.
/// A position that is off every screen is dropped, keeping the size.
pub fn load<R: Runtime>(
    app: &AppHandle<R>,
    min_width: f64,
    min_height: f64,
) -> Option<(Bounds, bool)> {
    let text = fs::read_to_string(file(app)?).ok()?;
    let bounds: Bounds = serde_json::from_str(&text).ok()?;
    if !bounds.is_sane(min_width, min_height) {
        return None;
    }
    let screens: Vec<Area> = app
        .available_monitors()
        .ok()?
        .iter()
        .map(Area::of)
        .collect();
    Some((bounds, bounds.is_visible_on(&screens)))
}

/// Records the window's current bounds. The size and position are only taken
/// while the window is in its normal state, so un-maximizing after a restart
/// returns to the size it had before.
pub fn track<R: Runtime>(window: &Window<R>) {
    let tracker = window.state::<Tracker>();
    let Ok(mut saved) = tracker.0.lock() else {
        return;
    };
    if window.is_minimized().unwrap_or(true) {
        return;
    }
    let maximized = window.is_maximized().unwrap_or(false);
    let fullscreen = window.is_fullscreen().unwrap_or(false);
    if maximized || fullscreen {
        if let Some(bounds) = saved.as_mut() {
            // Fullscreen is not restored; keep the state it replaced.
            if !fullscreen {
                bounds.maximized = true;
            }
            // Moved to another screen while maximized: restore there.
            if let Ok(Some(monitor)) = window.current_monitor() {
                bounds.move_onto(&Area::of(&monitor));
            }
        }
        return;
    }
    // macOS places a new window by its content area, with the title bar above
    // it; elsewhere a window is moved by its outer frame.
    let position = if cfg!(target_os = "macos") {
        window.inner_position()
    } else {
        window.outer_position()
    };
    let (Ok(scale), Ok(position), Ok(size)) =
        (window.scale_factor(), position, window.inner_size())
    else {
        return;
    };
    let (x, y) = desktop_position(position, scale);
    let size = size.to_logical::<f64>(scale);
    *saved = Some(Bounds {
        x,
        y,
        width: size.width,
        height: size.height,
        maximized: false,
    });
}

/// Writes the last recorded bounds to disk. Failures are ignored: the next
/// launch then opens at the default size.
/// Saves the window now. Installing an update on Windows ends the process
/// without the usual exit event, so the app calls this before it starts.
#[tauri::command]
pub fn save_window_state<R: Runtime>(app: AppHandle<R>) {
    save(&app);
}

pub fn save<R: Runtime>(app: &AppHandle<R>) {
    let tracker = app.state::<Tracker>();
    let Some(bounds) = tracker.0.lock().ok().and_then(|saved| *saved) else {
        return;
    };
    let Some(path) = file(app) else { return };
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_string(&bounds) {
        let _ = fs::write(path, json);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCREEN: Area = Area {
        x: 0.0,
        y: 0.0,
        width: 1440.0,
        height: 900.0,
        scale: 1.0,
    };
    const RIGHT: Area = Area {
        x: 1440.0,
        y: 0.0,
        width: 1920.0,
        height: 1080.0,
        scale: 1.0,
    };

    fn bounds(x: f64, y: f64) -> Bounds {
        Bounds {
            x,
            y,
            width: 1280.0,
            height: 840.0,
            maximized: false,
        }
    }

    #[test]
    fn keeps_positions_on_a_connected_screen() {
        assert!(bounds(80.0, 40.0).is_visible_on(&[SCREEN]));
        assert!(bounds(1600.0, 100.0).is_visible_on(&[SCREEN, RIGHT]));
        // Partly off the left edge, but the title bar can still be grabbed.
        assert!(bounds(-1000.0, 40.0).is_visible_on(&[SCREEN]));
    }

    #[test]
    fn drops_positions_off_every_screen() {
        // The second monitor was unplugged.
        assert!(!bounds(1600.0, 100.0).is_visible_on(&[SCREEN]));
        // Title bar above the top of the screen.
        assert!(!bounds(80.0, -200.0).is_visible_on(&[SCREEN]));
        assert!(!bounds(80.0, 890.0).is_visible_on(&[SCREEN]));
        assert!(!bounds(-1270.0, 40.0).is_visible_on(&[SCREEN]));
        assert!(!bounds(0.0, 0.0).is_visible_on(&[]));
    }

    #[test]
    fn checks_the_width_in_desktop_units() {
        // A 1280-point window at 200% is 2560 pixels wide: its right part is
        // still on screen. At 100% it would be off it.
        let hidpi = Area {
            scale: 2.0,
            width: 2880.0,
            height: 1800.0,
            ..SCREEN
        };
        assert!(bounds(-2400.0, 40.0).is_visible_on(&[hidpi]));
        assert!(!bounds(-2400.0, 40.0).is_visible_on(&[SCREEN]));
    }

    #[test]
    fn moves_onto_the_screen_it_was_maximized_on() {
        let mut moved = bounds(80.0, 40.0);
        moved.move_onto(&RIGHT);
        assert_eq!((moved.x, moved.y), (1440.0 + 320.0, 120.0));
        assert!(moved.is_visible_on(&[RIGHT]));
        // Mostly on the left screen, just reaching onto the right one.
        let mut reaching = bounds(240.0, 40.0);
        reaching.move_onto(&RIGHT);
        assert_eq!(reaching.x, 1440.0 + 320.0);
        // Already there: left where it was.
        let mut kept = bounds(80.0, 40.0);
        kept.move_onto(&SCREEN);
        assert_eq!(kept, bounds(80.0, 40.0));
    }

    #[test]
    fn rejects_nonsense_sizes() {
        assert!(bounds(0.0, 0.0).is_sane(480.0, 400.0));
        let too_small = Bounds {
            width: 100.0,
            ..bounds(0.0, 0.0)
        };
        assert!(!too_small.is_sane(480.0, 400.0));
        let not_a_number = Bounds {
            x: f64::NAN,
            ..bounds(0.0, 0.0)
        };
        assert!(!not_a_number.is_sane(480.0, 400.0));
        let huge = Bounds {
            height: 1e9,
            ..bounds(0.0, 0.0)
        };
        assert!(!huge.is_sane(480.0, 400.0));
    }

    #[test]
    fn round_trips_as_json() {
        let saved = Bounds {
            maximized: true,
            ..bounds(10.5, 20.0)
        };
        let json = serde_json::to_string(&saved).unwrap();
        assert_eq!(serde_json::from_str::<Bounds>(&json).unwrap(), saved);
    }
}
