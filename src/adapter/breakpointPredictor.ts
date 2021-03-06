/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as path from 'path';
import Dap from '../dap/api';
import * as urlUtils from '../common/urlUtils';
import { ISourcePathResolver } from '../common/sourcePathResolver';
import { ISourceMapRepository } from '../common/sourceMaps/sourceMapRepository';
import { ISourceMapMetadata } from '../common/sourceMaps/sourceMap';
import { SourceMapConsumer } from 'source-map';
import { MapUsingProjection } from '../common/datastructure/mapUsingProjection';
import { CorrelatedCache } from '../common/sourceMaps/mtimeCorrelatedCache';
import { logger } from '../common/logging/logger';
import { LogTag } from '../common/logging';
import { AnyLaunchConfiguration } from '../configuration';
import { EventEmitter } from '../common/events';
import { SourceMapFactory } from '../common/sourceMaps/sourceMapFactory';
import { logPerf } from '../telemetry/performance';

export interface IWorkspaceLocation {
  absolutePath: string;
  lineNumber: number; // 1-based
  columnNumber: number; // 1-based
}

type PredictedLocation = {
  source: IWorkspaceLocation;
  compiled: IWorkspaceLocation;
};

type DiscoveredMetadata = ISourceMapMetadata & { sourceUrl: string; resolvedPath: string };
type MetadataMap = Map<string, Set<DiscoveredMetadata>>;

const longPredictionWarning = 10 * 1000;

export type BreakpointPredictionCache = CorrelatedCache<number, DiscoveredMetadata[]>;

export class BreakpointsPredictor {
  private readonly predictedLocations: PredictedLocation[] = [];
  private readonly patterns: string[];
  private readonly rootPath: string;
  private readonly longParseEmitter = new EventEmitter<void>();
  private sourcePathToCompiled?: Promise<MetadataMap>;

  /**
   * Event that fires if it takes a long time to predict sourcemaps.
   */
  public readonly onLongParse = this.longParseEmitter.event;

  constructor(
    launchConfig: AnyLaunchConfiguration,
    private readonly repo: ISourceMapRepository,
    private readonly sourceMapFactory: SourceMapFactory,
    private readonly sourcePathResolver: ISourcePathResolver | undefined,
    private readonly cache: BreakpointPredictionCache | undefined,
  ) {
    this.rootPath = launchConfig.rootPath;
    this.patterns = launchConfig.outFiles.map(p =>
      path.isAbsolute(p) ? path.relative(launchConfig.rootPath, p) : p,
    );
  }

  @logPerf<BreakpointsPredictor>(m => ({ type: m.repo.constructor.name }))
  private async createInitialMapping(): Promise<MetadataMap> {
    if (this.patterns.length === 0) {
      return new Map();
    }

    const sourcePathToCompiled: MetadataMap = new MapUsingProjection(
      urlUtils.lowerCaseInsensitivePath,
    );
    const addDiscovery = (discovery: DiscoveredMetadata) => {
      let set = sourcePathToCompiled.get(discovery.resolvedPath);
      if (!set) {
        set = new Set();
        sourcePathToCompiled.set(discovery.resolvedPath, set);
      }

      set.add(discovery);
    };

    const warnLongRuntime = setTimeout(() => {
      this.longParseEmitter.fire();
      logger.warn(LogTag.RuntimeSourceMap, 'Long breakpoint predictor runtime', {
        type: this.repo.constructor.name,
        longPredictionWarning,
        patterns: this.patterns,
      });
    }, longPredictionWarning);

    await this.repo.streamAllChildren(this.rootPath, this.patterns, async metadata => {
      const cached = await this.cache?.lookup(metadata.compiledPath, metadata.mtime);
      if (cached) {
        cached.forEach(addDiscovery);
        return;
      }

      const map = await this.sourceMapFactory.load(metadata);
      if (!map) {
        return;
      }

      const discovered: DiscoveredMetadata[] = [];
      for (const url of map.sources) {
        const resolvedPath = this.sourcePathResolver
          ? await this.sourcePathResolver.urlToAbsolutePath({ url, map })
          : urlUtils.fileUrlToAbsolutePath(url);

        if (!resolvedPath) {
          continue;
        }

        const discovery = { ...metadata, resolvedPath, sourceUrl: url };
        discovered.push(discovery);
        addDiscovery(discovery);
      }

      this.cache?.store(metadata.compiledPath, metadata.mtime, discovered);
    });

    clearTimeout(warnLongRuntime);
    return sourcePathToCompiled;
  }

  /**
   * Returns a promise that resolves once maps in the root are predicted.
   */
  public async prepareToPredict(): Promise<void> {
    if (!this.sourcePathToCompiled) {
      this.sourcePathToCompiled = this.createInitialMapping();
    }

    await this.sourcePathToCompiled;
  }

  /**
   * Returns a promise that resolves when breakpoints for the given location
   * are predicted.
   */
  public async predictBreakpoints(params: Dap.SetBreakpointsParams): Promise<void> {
    if (!params.source.path) {
      return Promise.resolve();
    }
    if (!this.sourcePathToCompiled) {
      this.sourcePathToCompiled = this.createInitialMapping();
    }

    const sourcePathToCompiled = await this.sourcePathToCompiled;
    const absolutePath = params.source.path;
    if (!absolutePath) {
      return;
    }

    const set = sourcePathToCompiled.get(absolutePath);

    if (!set) return;
    for (const metadata of set) {
      if (!metadata.compiledPath) {
        return;
      }

      const map = await this.sourceMapFactory.load(metadata);
      if (!map) {
        continue;
      }

      for (const b of params.breakpoints || []) {
        const entry = map.generatedPositionFor({
          source: metadata.sourceUrl,
          line: b.line,
          column: b.column || 1,
          bias: SourceMapConsumer.LEAST_UPPER_BOUND,
        });
        if (entry.line === null) {
          continue;
        }

        const { lineNumber, columnNumber } = {
          lineNumber: entry.line || 1,
          columnNumber: entry.column ? entry.column + 1 : 1,
        };
        const predicted: PredictedLocation = {
          source: {
            absolutePath,
            lineNumber: b.line,
            columnNumber: b.column || 1,
          },
          compiled: {
            absolutePath: metadata.compiledPath,
            lineNumber,
            columnNumber,
          },
        };
        this.predictedLocations.push(predicted);
      }
    }
  }

  /**
   * Returns predicted breakpoint locations for the provided source.
   */
  public predictedResolvedLocations(location: IWorkspaceLocation): IWorkspaceLocation[] {
    const result: IWorkspaceLocation[] = [];
    for (const p of this.predictedLocations) {
      if (
        p.source.absolutePath === location.absolutePath &&
        p.source.lineNumber === location.lineNumber &&
        p.source.columnNumber === location.columnNumber
      ) {
        result.push(p.compiled);
      }
    }
    return result;
  }
}
