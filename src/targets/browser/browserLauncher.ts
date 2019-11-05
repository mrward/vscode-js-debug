// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as fs from 'fs';
import * as path from 'path';
import { Disposable, EventEmitter } from '../../common/events';
import * as nls from 'vscode-nls';
import CdpConnection from '../../cdp/connection';
import findBrowser from './findBrowser';
import * as launcher from './launcher';
import { BrowserTarget, BrowserTargetManager } from './browserTargets';
import { Target, Launcher, LaunchResult, ILaunchContext, IStopMetadata } from '../../targets/targets';
import { BrowserSourcePathResolver } from './browserPathResolver';
import { baseURL } from './browserLaunchParams';
import { AnyChromeConfiguration, IChromeLaunchConfiguration } from '../../configuration';
import { Contributions } from '../../common/contributionUtils';
import { EnvironmentVars } from '../../common/environmentVars';
import { ScriptSkipper } from '../../adapter/scriptSkipper';
import { RawTelemetryReporterToDap, RawTelemetryReporter } from '../../telemetry/telemetryReporter';
import { createTargetFilterForConfig } from '../../common/urlUtils';

const localize = nls.loadMessageBundle();

export class BrowserLauncher implements Launcher {
  private _connectionForTest: CdpConnection | undefined;
  private _storagePath: string;
  private _targetManager: BrowserTargetManager | undefined;
  private _disposables: Disposable[] = [];
  private _onTerminatedEmitter = new EventEmitter<IStopMetadata>();
  readonly onTerminated = this._onTerminatedEmitter.event;
  private _onTargetListChangedEmitter = new EventEmitter<void>();
  readonly onTargetListChanged = this._onTargetListChangedEmitter.event;

  constructor(storagePath: string) {
    this._storagePath = storagePath;
  }

  targetManager(): BrowserTargetManager | undefined {
    return this._targetManager;
  }

  dispose() {
    for (const disposable of this._disposables)
      disposable.dispose();
    this._disposables = [];
  }

  async _launchBrowser({ runtimeExecutable: executable, runtimeArgs, timeout, userDataDir, env, cwd }: IChromeLaunchConfiguration, rawTelemetryReporter: RawTelemetryReporter): Promise<CdpConnection> {
    let executablePath = '';
    if (executable && executable !== 'canary' && executable !== 'stable' && executable !== 'custom') {
      executablePath = executable;
    } else {
      const installations = findBrowser();
      if (executable) {
        const installation = installations.find(e => e.type === executable);
        if (installation)
          executablePath = installation.path;
      } else {
        // Prefer canary over stable, it comes earlier in the list.
        if (installations.length)
          executablePath = installations[0].path;
      }
    }

    let resolvedDataDir: string | undefined;
    if (userDataDir === true) {
        resolvedDataDir = path.join(this._storagePath, runtimeArgs && runtimeArgs.includes('--headless') ? '.headless-profile' : '.profile');
    } else if (typeof userDataDir === 'string') {
      resolvedDataDir = userDataDir;
    }

    if (!executablePath)
      throw new Error('Unable to find browser');

    try {
      fs.mkdirSync(this._storagePath);
    } catch (e) {
    }

    return await launcher.launch(
      executablePath, rawTelemetryReporter, {
        timeout,
        cwd: cwd || undefined,
        env: EnvironmentVars.merge(process.env, env),
        args: runtimeArgs || [],
        userDataDir: resolvedDataDir,
        pipe: true,
      });
  }

  async prepareLaunch(params: IChromeLaunchConfiguration, { targetOrigin }: ILaunchContext, rawTelemetryReporter: RawTelemetryReporter): Promise<BrowserTarget | string> {
    let connection: CdpConnection;
    try {
      connection = await this._launchBrowser(params, rawTelemetryReporter);
    } catch (e) {
      return localize('error.browserLaunchError', 'Unable to launch browser: "{0}"', e.message);
    }

    connection.onDisconnected(() => {
      this._onTerminatedEmitter.fire({ code: 0, killed: true });
    }, undefined, this._disposables);
    this._connectionForTest = connection;

    const pathResolver = new BrowserSourcePathResolver({
      baseUrl: baseURL(params),
      localRoot: null,
      remoteRoot: null,
      webRoot: params.webRoot || params.rootPath,
      sourceMapOverrides: params.sourceMapPathOverrides,
    });
    const tm = this._targetManager = await BrowserTargetManager.connect(connection, pathResolver, targetOrigin);
    if (!tm)
      return localize('error.unableToAttachToBrowser', 'Unable to attach to the browser');

    tm.serviceWorkerModel.onDidChange(() => this._onTargetListChangedEmitter.fire());
    tm.frameModel.onFrameNavigated(() => this._onTargetListChangedEmitter.fire());
    this._disposables.push(tm);

    tm.onTargetAdded((target: BrowserTarget) => {
      this._onTargetListChangedEmitter.fire();
    });
    tm.onTargetRemoved((target: BrowserTarget) => {
      this._onTargetListChangedEmitter.fire();
    });

    if (params.skipFiles) {
      tm.setSkipFiles(new ScriptSkipper(params.skipFiles));
    }

    tm.listenForTargets(
      createTargetFilterForConfig(params),
      (params as any).skipNavigateForTest || !params.url ? undefined : params.url,
    );

    const mainTarget = await new Promise<BrowserTarget | null>(resolve => {
      const timeout = setTimeout(() => {
        resolve(null);
        listener.dispose();
      }, params.timeout);

      const listener = tm.onTargetAdded(target => {
        resolve(target);
        listener.dispose();
        clearTimeout(timeout);
      });
    })

    if (!mainTarget) {
      return localize(
        'chrome.attach.noMatchingTarget',
        'Can\'t find a valid target that matches {0} within {1}ms',
        params.urlFilter || params.url,
        params.timeout,
      );
    }

    return mainTarget;
  }

  async launch(params: AnyChromeConfiguration, targetOrigin: any, telemetryReporter: RawTelemetryReporterToDap): Promise<LaunchResult> {
    if (params.type !== Contributions.ChromeDebugType || params.request !== 'launch') {
      return { blockSessionTermination: false };
    }

    const targetOrError = await this.prepareLaunch(params, targetOrigin, telemetryReporter);
    if (typeof targetOrError === 'string')
      return { error: targetOrError };

      return { blockSessionTermination: true };
  }

  async terminate(): Promise<void> {
    // no-op
  }

  async disconnect(): Promise<void> {
    if (this._targetManager)
      await this._targetManager.closeBrowser();
  }

  async restart(): Promise<void> {
    if (this._targetManager) {
      for (const target of this._targetManager.targetList()) {
        target.restart();
      }
    }
  }

  targetList(): Target[] {
    const manager = this.targetManager()
    return manager ? manager.targetList() : [];
  }

  connectionForTest(): CdpConnection | undefined {
    return this._connectionForTest;
  }
}
