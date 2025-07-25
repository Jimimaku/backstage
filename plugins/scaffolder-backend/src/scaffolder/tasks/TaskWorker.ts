/*
 * Copyright 2021 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { AuditorService, LoggerService } from '@backstage/backend-plugin-api';
import { assertError, stringifyError } from '@backstage/errors';
import { ScmIntegrations } from '@backstage/integration';
import { PermissionEvaluator } from '@backstage/plugin-permission-common';
import {
  TaskBroker,
  TaskContext,
  TemplateFilter,
  TemplateGlobal,
} from '@backstage/plugin-scaffolder-node';
import PQueue from 'p-queue';
import { TemplateActionRegistry } from '../actions';
import { NunjucksWorkflowRunner } from './NunjucksWorkflowRunner';
import { WorkflowRunner } from './types';
import { setTimeout } from 'timers/promises';

/**
 * TaskWorkerOptions
 * @deprecated this type is deprecated, and there will be a new way to create Workers in the next major version.
 * @public
 */
export type TaskWorkerOptions = {
  taskBroker: TaskBroker;
  runners: {
    workflowRunner: WorkflowRunner;
  };
  concurrentTasksLimit: number;
  permissions?: PermissionEvaluator;
  logger?: LoggerService;
  auditor?: AuditorService;
  gracefulShutdown?: boolean;
};

/**
 * CreateWorkerOptions
 * @deprecated this type is deprecated, and there will be a new way to create Workers in the next major version.
 * @public
 */
export type CreateWorkerOptions = {
  taskBroker: TaskBroker;
  actionRegistry: TemplateActionRegistry;
  integrations: ScmIntegrations;
  workingDirectory: string;
  logger: LoggerService;
  auditor?: AuditorService;
  additionalTemplateFilters?: Record<string, TemplateFilter>;
  /**
   * The number of tasks that can be executed at the same time by the worker
   * @defaultValue 10
   * @example
   * ```
   * {
   *   concurrentTasksLimit: 1,
   *   // OR
   *   concurrentTasksLimit: Infinity
   * }
   * ```
   */
  concurrentTasksLimit?: number;
  additionalTemplateGlobals?: Record<string, TemplateGlobal>;
  permissions?: PermissionEvaluator;
  gracefulShutdown?: boolean;
};

/**
 * TaskWorker
 * @deprecated this type is deprecated, and there will be a new way to create Workers in the next major version.
 * @public
 */
export class TaskWorker {
  private taskQueue: PQueue;
  private logger: LoggerService | undefined;
  private auditor: AuditorService | undefined;
  private stopWorkers: boolean;

  private constructor(private readonly options: TaskWorkerOptions) {
    this.stopWorkers = false;
    this.logger = options.logger;
    this.auditor = options.auditor;
    this.taskQueue = new PQueue({
      concurrency: options.concurrentTasksLimit,
    });
  }

  static async create(options: CreateWorkerOptions): Promise<TaskWorker> {
    const {
      taskBroker,
      logger,
      auditor,
      actionRegistry,
      integrations,
      workingDirectory,
      additionalTemplateFilters,
      concurrentTasksLimit = 10, // from 1 to Infinity
      additionalTemplateGlobals,
      permissions,
      gracefulShutdown,
    } = options;

    const workflowRunner = new NunjucksWorkflowRunner({
      actionRegistry,
      integrations,
      logger,
      auditor,
      workingDirectory,
      additionalTemplateFilters,
      additionalTemplateGlobals,
      permissions,
    });

    return new TaskWorker({
      taskBroker: taskBroker,
      runners: { workflowRunner },
      concurrentTasksLimit,
      permissions,
      auditor,
      gracefulShutdown,
    });
  }

  async recoverTasks() {
    try {
      await this.options.taskBroker.recoverTasks?.();
    } catch (err) {
      this.logger?.error(stringifyError(err));
    }
  }

  start() {
    (async () => {
      while (!this.stopWorkers) {
        await setTimeout(10000);
        await this.recoverTasks();
      }
    })();
    (async () => {
      while (!this.stopWorkers) {
        await this.onReadyToClaimTask();
        if (!this.stopWorkers) {
          const task = await this.options.taskBroker.claim();
          void this.taskQueue.add(() => this.runOneTask(task));
        }
      }
    })();
  }

  async stop() {
    this.stopWorkers = true;
    if (this.options?.gracefulShutdown) {
      while (this.taskQueue.size > 0) {
        await setTimeout(1000);
      }
    }
  }

  protected onReadyToClaimTask(): Promise<void> {
    if (this.taskQueue.pending < this.options.concurrentTasksLimit) {
      return Promise.resolve();
    }
    return new Promise(resolve => {
      // "next" event emits when a task completes
      // https://github.com/sindresorhus/p-queue#next
      this.taskQueue.once('next', () => {
        resolve();
      });
    });
  }

  async runOneTask(task: TaskContext) {
    const auditorEvent = await this.auditor?.createEvent({
      eventId: 'task',
      severityLevel: 'medium',
      meta: {
        actionType: 'execution',
        taskId: task.taskId,
        createdBy: task.createdBy,
        taskParameters: task.spec.parameters,
        templateRef: task.spec.templateInfo?.entityRef,
      },
    });

    try {
      if (task.spec.apiVersion !== 'scaffolder.backstage.io/v1beta3') {
        throw new Error(
          `Unsupported Template apiVersion ${task.spec.apiVersion}`,
        );
      }

      const { output } = await this.options.runners.workflowRunner.execute(
        task,
      );

      await task.complete('completed', { output });
      await auditorEvent?.success();
    } catch (error) {
      assertError(error);
      await auditorEvent?.fail({
        error,
      });
      await task.complete('failed', {
        error: { name: error.name, message: error.message },
      });
    }
  }
}
