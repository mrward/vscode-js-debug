import Cdp from '../../cdp/api';
import { BreakOnLoadStrategy } from '../../configuration';
import { BreakOnLoadOffHelper } from './breakOnLoadOff';
import { BreakOnLoadInstrumentHelper } from './breakOnLoadInstrument';

export interface IBreakOnLoadHelper {
  /**
   * Handles the AddBreakpoints request when break on load is active
   * Takes the action based on the strategy
   */
  runSetup(cdp: Cdp.Api): Promise<void>;

  /**
   * Handles the onpaused event. Returns whether we should continue or not
   * on this paused event
   */
  handleOnPaused(notification: Cdp.Debugger.PausedEvent): Promise<boolean>;
}

/**
 * Returns a break on load helper for the given strategy.
 */
export function getBreakOnLoadHelper(strategy: BreakOnLoadStrategy) {
  switch (strategy) {
    case BreakOnLoadStrategy.Instrument:
      return new BreakOnLoadInstrumentHelper();
    default:
      return new BreakOnLoadOffHelper();
  }
}
