import { Fragment } from 'react';

/** Renders permission names as an inline list: "A, B and C". */
export function PermissionList({ permissions }: { permissions: readonly string[] }) {
  return (
    <>
      {permissions.map((name, i) => (
        <Fragment key={name}>
          {i > 0 && (i === permissions.length - 1 ? ' and ' : ', ')}
          <em>{name}</em>
        </Fragment>
      ))}
    </>
  );
}
