import type { Provider, ProviderId } from './types';
import { github } from './github';
import { gitlab } from './gitlab';

/** Registry of supported services. Add new providers here. */
export const providers: Record<ProviderId, Provider> = {
  github,
  gitlab,
};
