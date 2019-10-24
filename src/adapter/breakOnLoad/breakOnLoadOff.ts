import { IBreakOnLoadHelper } from './breakOnLoadHelper';

/**
 * A stub break on load helper for when the setting is disabled.
 */
export class BreakOnLoadOffHelper implements IBreakOnLoadHelper {
  /**
   * @inheritdoc
   */
  public runSetup() {
    return Promise.resolve();
  }

  /**
   * @inheritdoc
   */
  public handleOnPaused() {
    // we don't set a BP, so the event will always have been user-initiated:
    return Promise.resolve(false);
  }
}
