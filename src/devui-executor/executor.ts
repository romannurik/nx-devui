import { ExecutorContext, ProjectGraph, PromiseExecutor, Target, parseTargetString, targetToTargetString } from '@nx/devkit';
import * as blessed from 'blessed';
import chalk from 'chalk';
import { ChildProcess, spawn } from 'child_process';
import { ansiRegex } from '../ansi-regex';
import type { DevExecutorSchema, TargetStatus } from './schema';

const SPINNER_DOTS = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

type TargetState = {
  target: Target;
  displayName: string;
  status: TargetStatus;
  statusMatchers: { re: RegExp, status: TargetStatus }[];
  log: string;
  strippedLog: string;
  process?: ChildProcess;
  exited?: boolean;
};

// TODO: why isn't resize working?

const devExecutor: PromiseExecutor<DevExecutorSchema> = async (options, context: ExecutorContext) => {
  let targetStates: TargetState[] = [];
  for (let [project, { targets }] of Object.entries(context.projectsConfigurations.projects)) {
    if (project === context.projectName) continue;
    for (let targetName of Object.keys(targets || {})) {
      let target: Target = { project, target: targetName };
      let targetString = targetToTargetString(target);
      let targetState: TargetState = {
        target,
        displayName: targetString,
        statusMatchers: [],
        status: 'loading',
        log: '',
        strippedLog: '',
      };
      let includeTarget = false;
      for (let [pattern, val] of Object.entries(options.targets)) {
        if (pattern === targetName || pattern === targetString) { // for now only support exact matches, and no project selection
          includeTarget = true;
        }
        if (typeof val === 'object') {
          targetState.statusMatchers = [
            ...targetState.statusMatchers,
            ...Object.entries(val.statusMatchers || {}).map(([re, status]) => ({ re: new RegExp(re, 'g'), status }))
          ];
        }
      }
      if (includeTarget) {
        targetStates.push(targetState);
      }
    }
  }

  // const PATH = process.env.PATH;
  // TODO: find a better way to run an arbitrary list of targets in parallel. for now the 
  // best option we have is to spawn `nx run-many` batched by projects containing a given target
  let targetsToBuild = computeTargetDependencies(targetStates.map(t => t.target), context.projectGraph);
  // await Promise.all(targetsToBuild.map(async target => {
  //   for await (let result of await runExecutor(target, {}, context)) {
  //     if (!result.success) throw new Error('fail');
  //   }
  // }));
  let projectsByTarget: Record<string, string[]> = {};
  for (let { project, target } of targetsToBuild) {
    projectsByTarget[target] = projectsByTarget[target] || [];
    projectsByTarget[target].push(project);
  }
  for (let [target, projects] of Object.entries(projectsByTarget)) {
    await new Promise<void>((resolve, reject) => {
      const cmd = spawn(
        'nx',
        ['run-many', '-t', target, '-p', projects.join(','), '--output-style=stream'],
        { cwd: context.cwd, stdio: ["pipe", "pipe", "pipe"] });
      cmd.stdin.end();
      cmd.stdout.on("data", (data) => process.stdout.write(data));
      cmd.stderr.on("data", (data) => process.stderr.write(data));
      cmd.on("error", reject);
      cmd.on("exit", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(code);
        }
      });
      return cmd;
    });
  }

  // process.env.PATH = PATH; // weirdly, PATH is broken after runExecutor ("nx" not found)

  const screen = blessed.screen({
    resizeTimeout: 10,
    useBCE: true,
    smartCSR: true,
    dockBorders: true,
    fullUnicode: true,
  });
  let selectedItem = 0;
  const nav = blessed.list({
    width: '30%+1',
    height: '100%',
    interactive: true,
    keys: true,
    mouse: true,
    left: '0%',
    top: '0%',
    border: {
      type: 'line'
    },
    style: {
      selected: {
        fg: 'black',
        bg: 'white',
        bold: true
      },
      focus: {
        border: {
          fg: 'green'
        },
      },
      border: {
        fg: '#f0f0f0'
      },
    }
  });

  let frame = 0;
  setInterval(() => {
    frame = (frame + 1) % SPINNER_DOTS.length;

    let statuses: Record<TargetStatus, string> = {
      loading: chalk.cyan(SPINNER_DOTS[frame]),
      success: chalk.green('✓'),
      error: chalk.red('✗'),
      warning: chalk.yellow('!'),
    };

    for (let i of targetStates.keys()) {
      let item = nav.getItem(i);
      let { status, displayName } = targetStates[i];
      nav.setItem(item, statuses[status] + ' ' + displayName);
      screen.render();
    }
  }, 80);

  screen.append(nav);
  for (let targetState of targetStates) {
    nav.add(targetState.displayName);
  }

  let logView = blessed.log({
    top: '0%',
    left: '30%',
    width: '70%',
    height: '100%',
    content: '',
    scrollable: true,
    mouse: true,
    keys: true,
    focusable: true,
    clickable: true,
    scrollbar: {
      style: {
        bg: 'yellow'
      }
    },
    tags: true,
    border: {
      type: 'line'
    },
    style: {
      focus: {
        border: {
          fg: 'green'
        },
      },
      border: {
        fg: '#f0f0f0'
      },
    }
  });
  screen.append(logView);
  let lastCtrlC = 0;
  screen.key(['C-c'], () => {
    targetStates.forEach(t => t.process?.kill('SIGINT'));
    if (lastCtrlC >= Date.now() - 2000) {
      // if pressing Ctrl+C in rapid succession, force kill the process
      process.exit(0);
    }
    lastCtrlC = Date.now();
  });
  screen.key(['tab', 'S-tab'], () => {
    screen.focusNext();
    screen.render();
  });
  nav.focus();
  screen.render();
  nav.on('select item', async (_, index) => {
    selectedItem = index;
    logView.content = targetStates[index].log;
    logView.scrollTo(Infinity);
    screen.render();
  });

  for (let [index, targetState] of targetStates.entries()) {
    let { target } = targetState;

    targetState.process = runTarget({
      target,
      context,
      onExit() {
        targetState.exited = true;
        if (targetStates.every(t => t.exited)) {
          process.exit(0);
        }
      },
      onLog(data) {
        let targetState = targetStates[index];
        targetState.log += data;
        targetState.strippedLog += data.replace(ansiRegex, '');
        let lastMatchIndex = -1;
        for (let { re, status } of targetState.statusMatchers) {
          let matches = [...targetState.strippedLog.matchAll(re)];
          let matchIndex = matches.at(-1)?.index ?? -1;
          if (matchIndex >= 0 && matchIndex >= lastMatchIndex) {
            targetState.status = status;
            lastMatchIndex = matchIndex;
          }
        }
        if (selectedItem === index) {
          logView.content += data;
          logView.scrollTo(logView.getScrollHeight() + 100);
          logView.screen.render();
        }
      },
      onStatus(status) {
        targetStates[index].status = status;
      }
    });
    // try to avoid nx clobbering itself
    // await new Promise(resolve => setTimeout(resolve, 1000));
  }

  await new Promise(resolve => { });
  return { success: true };
};

function computeTargetDependencies(targets: Target[], projectGraph: ProjectGraph): Target[] {
  let dependencies = new Set<string>();

  let _addTargetIfExists = ({ project, target }: Target) => {
    if (projectGraph.nodes[project].data.targets[target]) {
      dependencies.add(targetToTargetString({ project, target }));
    }
  };

  for (let { project, target } of targets) {
    let p = projectGraph.nodes[project].data.targets[target];
    for (let requiredTarget of p.dependsOn || []) {
      if (typeof requiredTarget !== 'string') {
        // TODO
        throw new Error('Non-string dependsOn not yet supported');
      }

      let deep = requiredTarget.startsWith('^');
      if (deep) {
        requiredTarget = requiredTarget.substring(1);
      }

      _addTargetIfExists({ project, target: requiredTarget });

      if (deep) {
        projectGraph.dependencies[project]
          .map(dep => dep.target)
          .filter(project => !!projectGraph.nodes[project])
          .forEach(project => {
            _addTargetIfExists({ project, target: requiredTarget });
          });
      }
    }
  }
  return [...dependencies].map(d => parseTargetString(d, projectGraph));
}

function runTarget({ target, context, onExit, onLog, onStatus }: {
  context: ExecutorContext;
  target: Target;
  onLog?: (data: string) => void,
  onStatus?: (status: TargetStatus) => void;
  onExit?: () => void;
}): ChildProcess {
  const cmd = spawn(
    'nx',
    ['run', targetToTargetString(target),
      '--output-style=stream-without-prefixes',
      '--excludeTaskDependencies',
      '--skipNxCache'],
    { cwd: context.cwd, stdio: ["pipe", "pipe", "pipe"] });
  // stdin && cmd.stdin.write(stdin);
  cmd.stdin.end();
  cmd.stdout.on("data", (data) => {
    onLog?.(data.toString("utf-8"));
  });
  cmd.stderr.on("data", (data) => {
    onLog?.(data.toString("utf-8"));
  });
  cmd.on("error", (err) => {
    onStatus?.('error');
    onExit?.();
  });
  cmd.on("exit", (code) => {
    onStatus?.('error');
    onExit?.();
  });
  return cmd;
}

export default devExecutor;
