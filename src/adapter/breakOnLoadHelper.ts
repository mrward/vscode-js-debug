/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { BreakOnLoadStrategy } from '../configuration';
import { Cdp } from '../cdp/api';
import { pathToRegex } from '../common/pathUtils';
import * as path from 'path';
import { SourceContainer } from './sources';
import { canonicalizeUrl } from '../common/urlUtils';
import { Script } from './threads';
import { BreakpointManager } from './breakpoints';

export interface UrlRegexAndFileSet {
  urlRegex: string;
  fileSet: Set<string>;
}

export class BreakOnLoadHelper {
  private _instrumentationBreakpointSet = false;

  // Break on load: Store some mapping between the requested file names, the regex for the file, and the chrome breakpoint id to perform lookup operations efficiently
  private _stopOnEntryBreakpointIdToRequestedFileName = new Map<string, UrlRegexAndFileSet>();
  private _stopOnEntryRequestedFileNameToBreakpointId = new Map<string, string>();
  private _stopOnEntryRegexToBreakpointId = new Map<string, string>();

  public constructor(
    private readonly breakpoints: BreakpointManager,
    private readonly cdp: Cdp.Api,
    private readonly scriptIdMap: Map<string, Script>,
    private readonly breakOnLoadStrategy: BreakOnLoadStrategy,
  ) {}

  public get stopOnEntryRequestedFileNameToBreakpointId(): Map<string, string> {
    return this._stopOnEntryRequestedFileNameToBreakpointId;
  }

  public get stopOnEntryBreakpointIdToRequestedFileName(): Map<string, UrlRegexAndFileSet> {
    return this._stopOnEntryBreakpointIdToRequestedFileName;
  }

  private get instrumentationBreakpointSet(): boolean {
    return this._instrumentationBreakpointSet;
  }

  private getScriptUrlFromId(scriptId: string): string | undefined {
    const script = this.scriptIdMap.get(scriptId);
    return script && script.url;
  }

  /**
   * Handles the onpaused event.
   * Checks if the event is caused by a stopOnEntry breakpoint of using the regex approach, or the paused event due to the Chrome's instrument approach
   * Returns whether we should continue or not on this paused event
   */
  public async handleOnPaused(notification: Cdp.Debugger.PausedEvent): Promise<boolean> {
    if (notification.hitBreakpoints && notification.hitBreakpoints.length) {
      // If breakOnLoadStrategy is set to regex, we may have hit a stopOnEntry breakpoint we put.
      // So we need to resolve all the pending breakpoints in this script and then decide to continue or not
      if (this.breakOnLoadStrategy === BreakOnLoadStrategy.Regex) {
        let shouldContinue = await this.handleStopOnEntryBreakpointAndContinue(notification);
        return shouldContinue;
      }
    } else if (this.isInstrumentationPause(notification)) {
      // This is fired when Chrome stops on the first line of a script when using the setInstrumentationBreakpoint API
      const pausedScriptId = notification.callFrames[0].location.scriptId;

      // Now we wait for all the pending breakpoints to be resolved and then continue
      // await this.cdp.getBreakpointsResolvedDefer(pausedScriptId).promise;
      // logger.log('BreakOnLoadHelper: Finished waiting for breakpoints to get resolved.');
      let shouldContinue = await this.handleStopOnEntryBreakpointAndContinue(notification);
      return shouldContinue;
    }

    return false;
  }

  private isInstrumentationPause(notification: Cdp.Debugger.PausedEvent): boolean {
    return (
      (notification.reason === 'EventListener' &&
        notification.data.eventName === 'instrumentation:scriptFirstStatement') ||
      (notification.reason === 'ambiguous' &&
        Array.isArray(notification.data.reasons) &&
        notification.data.reasons.every(
          r =>
            r.reason === 'EventListener' &&
            r.auxData.eventName === 'instrumentation:scriptFirstStatement',
        ))
    );
  }

  /**
   * Returns whether we should continue on hitting a stopOnEntry breakpoint
   * Only used when using regex approach for break on load
   */
  private async shouldContinueOnStopOnEntryBreakpoint(
    pausedLocation: Cdp.Debugger.Location,
  ): Promise<boolean> {
    // // If the file has no unbound breakpoints or none of the resolved breakpoints are at (1,1), we should continue after hitting the stopOnEntry breakpoint
    // let shouldContinue = true;

    // // Important: For the logic that verifies if a user breakpoint is set in the paused location, we need to resolve pending breakpoints, and commit them, before
    // // using committedBreakpointsByUrl for our logic.
    // // await this.cdp.getBreakpointsResolvedDefer(pausedLocation.scriptId).promise;

    // const pausedScriptUrl = this.getScriptUrlFromId(pausedLocation.scriptId);
    // // Important: We need to get the committed breakpoints only after all the pending breakpoints for this file have been resolved. If not this logic won't work
    // this.
    // const committedBps = this.cdp.committedBreakpointsByUrl.get(pausedScriptUrl) || [];
    // const anyBreakpointsAtPausedLocation =
    //   committedBps.filter(
    //     bp =>
    //       bp.actualLocation &&
    //       bp.actualLocation.lineNumber === pausedLocation.lineNumber &&
    //       bp.actualLocation.columnNumber === pausedLocation.columnNumber,
    //   ).length > 0;

    // // If there were any breakpoints at this location (Which generally should be (1,1)) we shouldn't continue
    // if (anyBreakpointsAtPausedLocation) {
    //   // Here we need to store this information per file, but since we can safely assume that scriptParsed would immediately be followed by onPaused event
    //   // for the breakonload files, this implementation should be fine
    //   shouldContinue = false;
    // }

    return false;
  }

  /**
   * Handles a script with a stop on entry breakpoint and returns whether we should continue or not on hitting that breakpoint
   * Only used when using regex approach for break on load
   */
  private async handleStopOnEntryBreakpointAndContinue(
    notification: Cdp.Debugger.PausedEvent,
  ): Promise<boolean> {
    // const hitBreakpoints = notification.hitBreakpoints;
    // let allStopOnEntryBreakpoints = true;

    // const pausedScriptId = notification.callFrames[0].location.scriptId;
    // const pausedScriptUrl = this.cdp.scriptsById.get(pausedScriptId).url;
    // const mappedUrl = await this.cdp.pathTransformer.scriptParsed(pausedScriptUrl);

    // // If there is a breakpoint which is not a stopOnEntry breakpoint, we appear as if we hit that one
    // // This is particularly done for cases when we end up with a user breakpoint and a stopOnEntry breakpoint on the same line
    // for (let bp of hitBreakpoints) {
    //   let regexAndFileNames = this._stopOnEntryBreakpointIdToRequestedFileName.get(bp);
    //   if (!regexAndFileNames) {
    //     notification.hitBreakpoints = [bp];
    //     allStopOnEntryBreakpoints = false;
    //   } else {
    //     const normalizedMappedUrl = canonicalizeUrl(mappedUrl);
    //     if (regexAndFileNames.fileSet.has(normalizedMappedUrl)) {
    //       regexAndFileNames.fileSet.delete(normalizedMappedUrl);
    //       // assert(
    //       //   this._stopOnEntryRequestedFileNameToBreakpointId.delete(normalizedMappedUrl),
    //       //   `Expected to delete break-on-load information associated with url: ${normalizedMappedUrl}`,
    //       // );

    //       if (regexAndFileNames.fileSet.size === 0) {
    //         // logger.log(
    //         //   `Stop on entry breakpoint hit for last remaining file. Removing: ${bp} created for: ${normalizedMappedUrl}`,
    //         // );
    //         await this.removeBreakpointById(bp);
    //         // assert(
    //         //   this._stopOnEntryRegexToBreakpointId.delete(regexAndFileNames.urlRegex),
    //         //   `Expected to delete break-on-load information associated with regexp: ${regexAndFileNames.urlRegex}`,
    //         // );
    //       } else {
    //         // logger.log(
    //         //   `Stop on entry breakpoint hit but still has remaining files. Keeping: ${bp} that was hit for: ${normalizedMappedUrl} because it's still needed for: ${Array.from(
    //         //     regexAndFileNames.fileSet.entries(),
    //         //   ).join(', ')}`,
    //         // );
    //       }
    //     }
    //   }
    // }

    // // If all the breakpoints on this point are stopOnEntry breakpoints
    // // This will be true in cases where it's a single breakpoint and it's a stopOnEntry breakpoint
    // // This can also be true when we have multiple breakpoints and all of them are stopOnEntry breakpoints, for example in cases like index.js and index.bin.js
    // // Suppose user puts breakpoints in both index.js and index.bin.js files, when the setBreakpoints function is called for index.js it will set a stopOnEntry
    // // breakpoint on index.* files which will also match index.bin.js. Now when setBreakpoints is called for index.bin.js it will again put a stopOnEntry breakpoint
    // // in itself. So when the file is actually loaded, we would have 2 stopOnEntry breakpoints */

    // if (allStopOnEntryBreakpoints) {
    //   const pausedLocation = notification.callFrames[0].location;
    //   let shouldContinue = await this.shouldContinueOnStopOnEntryBreakpoint(pausedLocation);
    //   if (shouldContinue) {
    //     return true;
    //   }
    // }
    return false;
  }

  /**
   * Adds a stopOnEntry breakpoint for the given script url
   * Only used when using regex approach for break on load
   */
  private async addStopOnEntryBreakpoint(url: string): Promise<void> {
    // Check if file already has a stop on entry breakpoint
    if (this._stopOnEntryRequestedFileNameToBreakpointId.has(url)) {
      return;
    }
    // Generate regex we need for the file
    const normalizedUrl = canonicalizeUrl(url);
    const urlRegex = getUrlRegexForBreakOnLoad(normalizedUrl);

    // Check if we already have a breakpoint for this regexp since two different files like script.ts and script.js may have the same regexp
    let breakpointId: string | undefined;
    breakpointId = this._stopOnEntryRegexToBreakpointId.get(urlRegex);

    // If breakpointId is undefined it means the breakpoint doesn't exist yet so we add it
    if (breakpointId === undefined) {
      let result: Cdp.Debugger.SetBreakpointByUrlResult | undefined;
      try {
        result = await this.setStopOnEntryBreakpoint(urlRegex);
      } catch (e) {
        // logger.log(
        //   `Exception occured while trying to set stop on entry breakpoint ${e.message}.`,
        // );
      }
      if (result) {
        breakpointId = result.breakpointId;
        this._stopOnEntryRegexToBreakpointId.set(urlRegex, breakpointId);
      } else {
        // logger.log(
        //   `BreakpointId was null when trying to set on urlregex ${urlRegex}. This normally happens if the breakpoint already exists.`,
        // );
        return;
      }
    }

    // Store the new breakpointId and the file name in the right mappings
    this._stopOnEntryRequestedFileNameToBreakpointId.set(normalizedUrl, breakpointId);

    let regexAndFileNames = this._stopOnEntryBreakpointIdToRequestedFileName.get(breakpointId);

    // If there already exists an entry for the breakpoint Id, we add this file to the list of file mappings
    if (regexAndFileNames !== undefined) {
      regexAndFileNames.fileSet.add(normalizedUrl);
    } else {
      // else create an entry for this breakpoint id
      const fileSet = new Set<string>();
      fileSet.add(normalizedUrl);
      this._stopOnEntryBreakpointIdToRequestedFileName.set(breakpointId, { urlRegex, fileSet });
    }
  }

  /**
   * Handles the AddBreakpoints request when break on load is active
   * Takes the action based on the strategy
   */
  public async handleAddBreakpoints(url: string): Promise<void> {
    // If the strategy is set to regex, we try to match the file where user put the breakpoint through a regex and tell Chrome to put a stop on entry breakpoint there
    if (this.breakOnLoadStrategy === BreakOnLoadStrategy.Regex) {
      await this.addStopOnEntryBreakpoint(url);
    } else if (this.breakOnLoadStrategy === BreakOnLoadStrategy.Instrument) {
      // Else if strategy is to use Chrome's experimental instrumentation API, we stop on all the scripts at the first statement before execution
      if (!this.instrumentationBreakpointSet) {
        await this.setInstrumentationBreakpoint();
      }
    }
  }

  /**
   * Tells Chrome to set instrumentation breakpoint to stop on all the scripts before execution
   * Only used when using instrument approach for break on load
   */
  private async setInstrumentationBreakpoint(): Promise<void> {
    await this.cdp.DOMDebugger.setInstrumentationBreakpoint({
      eventName: 'scriptFirstStatement',
    });
    this._instrumentationBreakpointSet = true;
  }

  // Sets a breakpoint on (0,0) for the files matching the given regex
  private async setStopOnEntryBreakpoint(
    urlRegex: string,
  ): Promise<Cdp.Debugger.SetBreakpointByUrlResult | undefined> {
    let result = await this.cdp.Debugger.setBreakpointByUrl({
      urlRegex,
      lineNumber: 0,
      columnNumber: 0,
    });
    return result;
  }

  // Removes a breakpoint by it's chrome-Cdp-id
  private async removeBreakpointById(breakpointId: string): Promise<void> {
    await this.cdp.Debugger.removeBreakpoint({
      breakpointId: breakpointId,
    });
  }

  /**
   * Checks if we need to call resolvePendingBPs on scriptParsed event
   * If break on load is active and we are using the regex approach, only call the resolvePendingBreakpoint function for files where we do not
   * set break on load breakpoints. For those files, it is called from onPaused function.
   * For the default Chrome's API approach, we don't need to call resolvePendingBPs from inside scriptParsed
   */
  public shouldResolvePendingBPs(mappedUrl: string): boolean {
    if (
      this.breakOnLoadStrategy === 'regex' &&
      !this.stopOnEntryRequestedFileNameToBreakpointId.has(mappedUrl)
    ) {
      return true;
    }
    return false;
  }
}

/* Constructs the regex for files to enable break on load
For example, for a file index.js the regex will match urls containing index.js, index.ts, abc/index.ts, index.bin.js etc
It won't match index100.js, indexabc.ts etc */
export function getUrlRegexForBreakOnLoad(url: string): string {
  const fileNameWithoutFullPath = path.parse(url).base;
  const fileNameWithoutExtension = path.parse(fileNameWithoutFullPath).name;
  const escapedFileName = pathToRegex(fileNameWithoutExtension);
  return '.*[\\\\\\/]' + escapedFileName + '([^A-z^0-9].*)?$';
}
