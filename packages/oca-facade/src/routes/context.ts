import type { EventPump } from '../event-pump';
import type { FacadeHarness } from '../harness';
import type { SessionRegistry } from '../session-registry';

/** Shared per-server collaborators handed to every route module. */
export interface RouteContext {
  readonly registry: SessionRegistry;
  readonly harness: FacadeHarness;
  readonly pump: EventPump;
}
