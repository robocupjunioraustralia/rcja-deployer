const path = require("path");
const { spawn } = require('child_process');

async function rebuildNPM(selected_deployment, buildCmd = 'build') {
    let hasFailed = false;
    let npmLog = '\n\n[NPM] Running npm commands...';
    console.log('[NPM] Running npm commands...');

    const spawnNpm = async (command, args) => {
        process.env.FORCE_COLOR = "true";
        return new Promise((resolve, reject) => {
            const npm = spawn(command, args, {
                cwd: path.join(selected_deployment.path),
                env: {
                    ...process.env,
                    NPM_CONFIG_COLOR: 'always',
                    NPM_CONFIG_FUND: 'false',
                }
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

    console.log("[NPM] Installing npm packages...");
    npmLog += "\n[NPM] Installing npm packages...";

    await spawnNpm('npm', ['install']).catch((err) => {
        console.error('[NPM] npm install failed');
        npmLog += '\n[NPM] npm install failed';
        console.error(err);
        npmLog += `\n${err}`;
        hasFailed = true;
    });

    if (!hasFailed) {
        console.log("[NPM] Pruning old npm packages...");
        npmLog += "\n[NPM] Pruning old npm packages...";

        await spawnNpm('npm', ['prune', '--no-audit']).catch((err) => {
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

        await spawnNpm('npm', ['run', buildCmd]).catch((err) => {
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

module.exports = {
    rebuildNPM
};
