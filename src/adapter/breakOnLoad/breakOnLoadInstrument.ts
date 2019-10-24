import { IBreakOnLoadHelper } from './breakOnLoadHelper';
import Cdp from '../../cdp/api';

/**
 * Implementation of BreakOnLoad using the instrumentation hooks
 * in CDP.
 */
export class BreakOnLoadInstrumentHelper implements IBreakOnLoadHelper {
  /**
   * @inheritdoc
   */
  public async runSetup(cdp: Cdp.Api): Promise<void> {
    await cdp.Debugger.setInstrumentationBreakpoint({
      instrumentation: 'beforeScriptExecution'
    });
  }

  /**
   * @inheritdoc
   */
  public handleOnPaused(notification: Cdp.Debugger.PausedEvent): Promise<boolean> {
    return Promise.resolve(notification.reason === 'instrumentation');
  }
}
