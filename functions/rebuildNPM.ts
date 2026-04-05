import path from "path";
import { spawn } from 'child_process';
import chalk from 'chalk';
import { config } from '../config';
import type { Deployment } from "./deployment";

export async function rebuildNPM(
    deployment: Deployment,
    buildCmd: Deployment["build_cmd"] | "build" | "publish" | "watch",
    buildOnly = false
) {
    let hasFailed = false;
    let npmLog = '\n\n[NPM] Running npm commands...';
    console.log('[NPM] Running npm commands...');

    const spawnNpm = async (command, args) => {
        config.FORCE_COLOR = "true";
        return new Promise((resolve, reject) => {
            const npm = spawn(command, args, {
                cwd: path.join(deployment.path),
                env: {
                    ...config,
                    NPM_CONFIG_COLOR: 'always',
                    NPM_CONFIG_FUND: 'false',
                },
                shell: true,
            });
            npm.stdout.on('data', (data) => {
                console.log(data.toString());
                npmLog += data;
            });
            npm.stderr.on('data', (data) => {
                console.log(data.toString());
                npmLog += data;
            });
            npm.on('exit', (code) => {
                if (code === 0) {
                    resolve();
                } else {
                    console.error(`[NPM] ${args.join(' ')} failed`);
                    npmLog += `\n[NPM] ${args.join(' ')} failed`;
                    hasFailed = true;
                    reject();
                }
            });
            npm.on('error', (err) => {
                console.error(`[NPM] ${args.join(' ')} failed`);
                npmLog += `\n[NPM] ${args.join(' ')} failed`;
                hasFailed = true;
                reject(err);
            });
        });
    };

    if (!buildOnly) {
        console.log("[NPM] Installing npm packages...");
        npmLog += "\n[NPM] Installing npm packages...";

        await spawnNpm(config.NPM_PATH, ['ci']).catch((err) => {
            console.error('[NPM] npm ci failed');
            npmLog += '\n[NPM] npm ci failed';
            console.error(err);
            npmLog += `\n${err}`;
            hasFailed = true;
        });
    }

    if (!hasFailed && !buildOnly) {
        console.log("[NPM] Pruning old npm packages...");
        npmLog += "\n[NPM] Pruning old npm packages...";

        await spawnNpm(config.NPM_PATH, ['prune', '--no-audit']).catch((err) => {
            console.error('[NPM] npm prune failed');
            npmLog += '\n[NPM] npm prune failed';
            console.error(err);
            npmLog += `\n${err}`;
            hasFailed = true;
        });
    }

    if (!hasFailed) {
        console.log(`[NPM] Running npm run ${buildCmd}...`);
        npmLog += `\n[NPM] Running npm run ${buildCmd}...`;

        if (buildCmd === "watch") {
            console.log(chalk.blue("[DEPLOYER] Running NPM in watch mode. This will not exit until you press Ctrl+C."));
        }

        await spawnNpm(config.NPM_PATH, ['run', buildCmd]).catch((err) => {
            console.error('[NPM] npm run ' + buildCmd + ' failed');
            npmLog += '\n[NPM] npm run ' + buildCmd + ' failed';
            console.error(err);
            npmLog += `\n${err}`;
            hasFailed = true;
        });
    }

    if (hasFailed) { return [hasFailed, npmLog]; }
    return [hasFailed, npmLog];
}
