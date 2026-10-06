import type { Provider, ProviderId } from './types';
import { github } from './github';

/** Registry of supported services. Add new providers here. */
export const providers: Record<ProviderId, Provider> = {
  github,
};
