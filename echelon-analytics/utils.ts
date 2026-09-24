import { createDefine } from "fresh";
import type { DbAdapter } from "./lib/db/adapter.ts";
import type { TelemetryState } from "./lib/telemetry.ts";

export interface State {
  db: DbAdapter;
  isAuthenticated: boolean;
  siteId: string;
  knownSites: string[];
  days: number;
  telemetryState: TelemetryState;
  url: string;
}

export const define = createDefine<State>();
