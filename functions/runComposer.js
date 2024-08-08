const path = require("path");
const { spawn } = require('child_process');

async function runComposer(selected_deployment) {
    let hasFailed = false;
    let composerLog = '\n\n[COMPOSER] Running composer install...';
    console.log('[COMPOSER] Running composer install...');

    const spawnComposer = async () => {
        return new Promise((resolve, reject) => {
            const composer = spawn(process.env.COMPOSER_PATH, ['install', '--no-dev', '--no-interaction', '--no-progress', '--optimize-autoloader'], {
                cwd: path.join(selected_deployment.path),
                shell: true
            });
            composer.stdout.on('data', (data) => {
                console.log(data.toString());
                composerLog += data;
            });
            composer.stderr.on('data', (data) => {
                console.log(data.toString());
                composerLog += data;
            });
            composer.on('exit', (code) => {
                if (code === 0) {
                    resolve();
                } else {
                    console.error('[COMPOSER] Composer install failed');
                    composerLog += '\n[COMPOSER] Composer install failed';
                    hasFailed = true;
                    reject();
                }
            });
            composer.on('error', (err) => {
                console.error('[COMPOSER] Composer install failed');
                composerLog += '\n[COMPOSER] Composer install failed';
                hasFailed = true;
                reject(err);
            });
        });
    };

    await spawnComposer().catch((err) => {
        console.error('[COMPOSER] Composer install failed');
        composerLog += '\n[COMPOSER] Composer install failed';
        console.error(err);
        composerLog += `\n${err}`;
        hasFailed = true;
    });
    if (hasFailed) { return [hasFailed, composerLog]; }

    console.log('[COMPOSER] Composer install finished');
    composerLog += '\n[COMPOSER] Composer install finished';
    return [hasFailed, composerLog];
}

module.exports = {
    runComposer
};
