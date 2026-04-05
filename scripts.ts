// Runner for command-line scripts

import { exec } from 'child_process';
import path from "path";
import fs from 'fs';
import os from 'os';
import inquirer from 'inquirer';
import unzipper from 'unzipper';
import chalk from 'chalk';
import { Readable } from 'stream';
import { finished } from 'stream/promises';
import { config } from './config';
import { runSyncDatabases } from './functions/syncDatabases';
import { runImportDatabases } from './functions/importDatabases';
import { anonymiseDatabase } from './functions/anonymiseDatabase';
import { rebuildForeignKeys } from './functions/rebuildForeignKeys';
import { runDatabaseMigrations } from './functions/migrate';
import { rebuildUsers } from './functions/rebuildUsers';
import { rebuildNPM } from './functions/rebuildNPM';
import { getDeploymentBackupDir } from "./functions/backup";
import { rebuildViews } from './functions/docker';
import { getDeployment } from './functions/deployment';

/**
 * Check that the deployer is up to date before proceeding
 * @returns {Promise<boolean>} - true if up to date, or if the user chooses to continue anyway
 */
async function checkUpToDate() {
    const git_status = await new Promise((resolve, reject) => {
        exec('git fetch && git status', (error, stdout, stderr) => {
            if (error) {
                reject(error);
                return;
            }
            resolve(stdout);
        });
    });

    if (!git_status.includes('Your branch is up to date with')) {
        const outdated_git_confirm = await inquirer.prompt([
            {
                type: 'confirm',
                name: 'continue',
                message: `Your deployer is out of date, you should 'git pull' first. Continue anyway?`,
                default: false,
            }
        ]);

        if (!outdated_git_confirm.continue) {
            return false;
        }
    }

    return true;
}

// npm run update (deployment)
//   Interactive script to update a deployment
//
//   params:
//   deployment (optional) - deployment key, falls back to the first deployment in deployments.json
export async function triggerUpdate() {
    if (!(await checkUpToDate())) {
        return;
    }

    const deployment = getDeployment(process.argv[process.argv.indexOf('update') + 1], true);

    console.log(chalk.blue(`[DEPLOYER] Updating ${deployment.title}...`));
    console.log(chalk.cyan(`[INFO] This tool allows you to:`));
    console.log(chalk.cyan(`[INFO] - Run any new migration scripts`));
    console.log(chalk.cyan(`[INFO] - Rebuild all views`));
    console.log(chalk.cyan(`[INFO] - Install NPM dependencies`));
    console.log(chalk.cyan(`[INFO] - Build assets, or actively watch for changes`));
    console.log(chalk.cyan(`[INFO]`));
    console.log(chalk.cyan(`[INFO] When you pull down changes from the repository,\n`
                         + `       this script will help you ensure your database is up to date\n`
                         + `       and all CSS/JS/etc assets are built correcly.`));
    console.log(chalk.cyan(`[INFO] Keep the watch script running whilst you are developing as\n`
                         + `       this will automatically rebuild assets when you change them.`));

    const user_answers = await inquirer.prompt([
        {
            type: 'confirm',
            name: 'run_migrations',
            message: `Run any new migration scripts?`,
            default: true,
        },
        {
            type: 'confirm',
            name: 'rebuild_views',
            message: `Rebuild all views?`,
            default: true,
        },
        {
            type: 'rawlist',
            name: 'npm_command',
            message: `Assets must be rebuilt. What would you like to do?`,
            choices: [
                { name: 'Watch for changes (recommended)', value: 'watch' },
                { name: 'One-Time (develop)', value: 'build' },
                { name: 'One-Time (production)', value: 'publish' },
            ],
            default: 0,
        }
    ]);

    console.log("\n\n");

    if (user_answers.run_migrations) {
        // To mimic the production build process, we build assets before running migrations,
        // so make sure that happens in case a migration uses a new asset
        await rebuildNPM(deployment, 'build', true);

        console.log(chalk.blue(`[DEPLOYER] Running migrations on ${deployment.title}...`))
        const [migrateFailed, migrateLog] = await runDatabaseMigrations(
            deployment,
            !deployment.backup,
            deployment.no_composer_dev || user_answers.npm_command === 'publish',
        );
        if (migrateFailed) {
            console.error(chalk.red(`[DEPLOYER] Failed to run migrations on ${deployment.title}`));
            return;
        }
    }

    if (user_answers.rebuild_views) {
        console.log(chalk.blue(`[DEPLOYER] Rebuilding views on ${deployment.title}...`))
        const rebuildViewsResult = await rebuildViews(deployment);
        if (rebuildViewsResult.error) throw rebuildViewsResult.error;
    }

    console.log(chalk.blue(`[DEPLOYER] Installing NPM dependencies and running ${user_answers.npm_command} script for ${deployment.title}...`))
    await rebuildNPM(deployment, user_answers.npm_command);
}


// npm run import (deployment)
//   Interactive script to import databases to a deployment
//   CAUTION: This will overwrite the target databases
//
//   params:
//   deployment (optional) - deployment key, falls back to the first deployment in deployments.json
export async function triggerImport() {
    if (!(await checkUpToDate())) {
        return;
    }

    const deployment = getDeployment(process.argv[process.argv.indexOf('import') + 1], true);

    let hasConfirmed = false;
    async function promptContinue() {
        if (hasConfirmed) {
            return true;
        }

        console.log(chalk.redBright(`\n[WARNING] This will delete all existing local databases for this deployment`));
        const importConfirmed = await inquirer.prompt([
            {
                type: 'input',
                name: 'confirm',
                message: `Are you sure you want to continue? Write 'delete' to confirm.`,
            }
        ]);

        hasConfirmed = importConfirmed.confirm === 'delete';
        return hasConfirmed;
    }

    console.log(chalk.blue(`[DEPLOYER] Import databases (${deployment.title})`));
    console.log(chalk.cyan(`[INFO] This tool allows you to restore your deployment's databases from a backup`));
    console.log(" ");

    const { importSource } = await inquirer.prompt([
        {
            type: 'rawlist',
            name: 'importSource',
            message: `Select the import source to use:`,
            choices: [
                { name: `Local - Backup created by the deployer in ./backups/${deployment.database_prefix}`, value: 'local-backup' },
                { name: 'Local - SQL files on the local machine', value: 'local-sql' },
                { name: 'Remote - Import a backup from a remote deployment', value: 'remote' },
            ],
        }
    ]);

    const mainFiles = [];
    const compFiles = [];

    if (importSource === 'remote') {

        if (!deployment.import) {
            console.error(chalk.red(`\n[DEPLOYER] Remote import is not configured in deployments.json for ${deployment.title}`));
            return;
        }

        const { remoteImportSource } = await inquirer.prompt([
            {
                type: 'rawlist',
                name: 'remoteImportSource',
                message: 'Select a method to retrieve the remote backup:',
                choices: [
                    { name: 'Latest - The latest existing backup on the remote deployment', value: 'latest' },
                    { name: 'Custom - Provide the name of a specific backup on the remote deployment', value: 'custom' },
                    { name: 'New - Trigger a new backup on the remote deployment and import it', value: 'new' },
                ],
            }
        ]);

        let backupName = null;
        if (remoteImportSource === 'latest') {
            backupName = 'latest';
        } else if (remoteImportSource === 'custom') {
            const { customBackupName } = await inquirer.prompt([
                {
                    type: 'input',
                    name: 'customBackupName',
                    message: 'Enter the name of the backup to import:',
                }
            ]);
            backupName = customBackupName;
        }

        if (!(await promptContinue())) {
            console.log(chalk.yellow(`\n[DEPLOYER] Import cancelled.`));
            return;
        }

        const remoteUrlBase = `${deployment.import.remote_host}/export/${deployment.import.deployment}`;
        const remoteHeaders = {
            'Authorization': `Bearer ${deployment.import.secret}`
        };

        if (backupName === null) {
            // Create a new backup on the remote deployment
            console.log(`\n[DEPLOYER] Creating new backup on ${remoteUrlBase}...`);

            const backupResponse = await fetch(remoteUrlBase, { method: 'POST', headers: remoteHeaders });
            if (!backupResponse.ok) {
                console.error(chalk.red(`[DEPLOYER] Failed to create new backup on remote: ${backupResponse.status} ${backupResponse.statusText}`));
                console.error(await backupResponse.text());
                return;
            }

            const backupData = await backupResponse.json();
            backupName = backupData.name;
        }

        console.log(`\n[DEPLOYER] Retrieving backup "${backupName}" from ${remoteUrlBase}...`);

        const exportResponse = await fetch(`${remoteUrlBase}/${backupName}`, { headers: remoteHeaders });
        if (!exportResponse.ok) {
            console.error(chalk.red(`[DEPLOYER] Failed to download backup from remote: ${exportResponse.status} ${exportResponse.statusText}`));
            console.error(await exportResponse.text());
            return;
        }

        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcja-deployer-import-'));
        const zipPath = path.join(tempDir, `${deployment.database_prefix}_backup.zip`);
        const fileStream = fs.createWriteStream(zipPath);

        await finished(Readable.fromWeb(exportResponse.body).pipe(fileStream));


        console.log(`[DEPLOYER] Downloaded backup to ${zipPath}`);

        const formattedDate = new Date().toISOString().replaceAll(':', '-').split('.')[0];

        const backupDir = path.join(
            getDeploymentBackupDir(deployment, true),
            `${formattedDate}_remote`
        );
        if (!fs.existsSync(backupDir)) {
            fs.mkdirSync(backupDir);
        }

        await fs.createReadStream(zipPath)
            .pipe(unzipper.Extract({ path: backupDir }))
            .promise();

        console.log(`[DEPLOYER] Extracted backup to ${backupDir}`);

        for (const file of fs.readdirSync(backupDir)) {
            if (!file.endsWith('.sql')) {
                continue;
            }

            if (file.startsWith(`${deployment.database_prefix}_main`)) {
                mainFiles.push(path.join(backupDir, file));
            }

            if (file.startsWith(`${deployment.database_prefix}_comp`)) {
                compFiles.push(path.join(backupDir, file));
            }
        }
    } else if (importSource === 'local-backup') {
        const deploymentBackupDir = getDeploymentBackupDir(deployment, false);
        if (!deploymentBackupDir) {
            console.error(chalk.red(`[DEPLOYER] No backups found for deployment "${deployment.title}"`));
            return;
        }

        const backupFiles = fs.readdirSync(deploymentBackupDir, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .sort()
            .reverse();

        const selectedBackup = await inquirer.prompt([
            {
                type: 'rawlist',
                name: 'backupDir',
                message: `Select a backup to import:`,
                choices: backupFiles,
            }
        ]);

        const backupDirPath = path.join(backupsPath, selectedBackup.backupDir);
        for (const file of fs.readdirSync(backupDirPath)) {
            if (!file.endsWith('.sql')) {
                continue;
            }

            if (file.startsWith(`${deployment.database_prefix}_main`)) {
                mainFiles.push(path.join(backupDirPath, file));
            }

            if (file.startsWith(`${deployment.database_prefix}_comp`)) {
                compFiles.push(path.join(backupDirPath, file));
            }
        }
    } else if (importSource === 'local-sql') {
        console.log(" ");
        console.log(chalk.yellow(`[INFO] Make sure each SQL dump file has the database prefix of '${deployment.database_prefix}'`));

        const answers = await inquirer.prompt([
            {
                type: 'input',
                name: 'mainDBFile',
                message: `Path to SQL dump for ${deployment.database_prefix}_main:`,
            },
            {
                type: 'input',
                name: 'compDBFile',
                message: `Path to SQL dump for ${deployment.database_prefix}_comp:`,
            }
        ]);

        mainFiles.push(answers.mainDBFile);
        compFiles.push(answers.compDBFile);
    }

    /** Make sure the files exist */
    console.log(" ");
    if (mainFiles.length === 0 && compFiles.length === 0) {
        console.error(chalk.red(`[DEPLOYER] No database files found to import`));
        return;
    }

    console.log(chalk.grey(`[DEPLOYER] Files to import:`));
    let hasInvalidFiles = false;
    [...mainFiles, ...compFiles].forEach((file) => {
        if (!fs.existsSync(file)) {
            console.error(chalk.red(` - Not Found: ${file}`));
            hasInvalidFiles = true;
            return;
        }

        console.log(chalk.grey(` - ${file}`));
    });

    if (hasInvalidFiles) {
        return;
    }

    if (!(await promptContinue())) {
        console.log(chalk.yellow(`\n[DEPLOYER] Import cancelled.`));
        return;
    }

    console.log("\n");

    console.log(chalk.blue(`[DEPLOYER] Importing databases to ${deployment.title}...`))
    const [importFailed, importLog] = await runImportDatabases(deployment, mainFiles, compFiles);
    if (importFailed) {
        console.error(chalk.red(`[DEPLOYER] Failed to import databases to ${deployment.title}`));
        return;
    }

    console.log(chalk.green(`\n\nDone!`));
    console.log(chalk.cyan(`[INFO] If this is a development environment, you may wish to run 'npm run update' next`));
}

// npm run migrate (deployment)
//   Runs any new migration scripts in the updates folder
//
//   params:
//   deployment (optional) - deployment key, falls back to the first deployment in deployments.json
export async function triggerMigrate() {
    const deployment = getDeployment(process.argv[process.argv.indexOf('migrate') + 1], true);

    console.log(`Running migrations on ${deployment.title}...`)
    const [migrateFailed, migrateLog] = await runDatabaseMigrations(
        deployment,
        !deployment.backup,
        deployment.no_composer_dev || false,
    );

    if (migrateFailed) {
        console.error(`Failed to run migrations on ${deployment.title}`);
        return;
    }

    console.log(`Rebuilding views on ${deployment.title}...`)
    await rebuildViews(deployment);
    console.log(`\n\nDone!`)
}

// npm run rebuildViews (deployment)
//   Rebuilds all views in the database
//
//   params:
//   deployment (optional) - deployment key, falls back to the first deployment in deployments.json
export async function triggerRebuildViews() {
    const deployment = getDeployment(process.argv[process.argv.indexOf('rebuildViews') + 1], true);

    console.log(`Rebuilding views on ${deployment.title}...`)
    const rebuildViewsResult = await rebuildViews(deployment);
    if (rebuildViewsResult.error) throw rebuildViewsResult.error;
}

// npm run anonymise (deployment)
//   Anonymises the database
//
//   params:
//   deployment (optional) - deployment key, falls back to the first deployment in deployments.json
export async function triggerAnonymise() {
    const deployment = getDeployment(process.argv[process.argv.indexOf('anonymise') + 1], true);

    console.log(`Anonymising ${deployment.title}...`)
    await anonymiseDatabase(deployment);
}

// npm run syncDatabases (deployment)
//   Syncronises the production database to the development database
//   uses env.SYNC_FROM_DEPLOYMENT and env.SYNC_TO_DEPLOYMENT to determine which deployments to sync
export async function triggerSyncDatabases() {
    const fromDeployment = getDeployment(config.SYNC_FROM_DEPLOYMENT, true);
    const toDeployment = getDeployment(config.SYNC_TO_DEPLOYMENT, true);
    console.log(`Syncronising deployments...`)
    await runSyncDatabases(fromDeployment, toDeployment);
}

// npm run rebuildUsers (deployment)
//   Rebuilds all users for a database
//
//   params:
//   deployment (optional) - deployment key, falls back to the first deployment in deployments.json
export async function triggerRebuildUsers() {
    const deployment = getDeployment(process.argv[process.argv.indexOf('rebuildUsers') + 1], true);

    console.log(`Recreating Users for ${deployment.title}...`)
    await rebuildUsers(deployment);
}

// npm run rebuildForeignKeys (deployment)
//   Rebuilds all foriegn keys in the database
//
//   params:
//   deployment (optional) - deployment key, falls back to the first deployment in deployments.json
export async function triggerRebuildForeignKeys() {
    const deployment = getDeployment(process.argv[process.argv.indexOf('rebuildForeignKeys') + 1], true);

    console.log(`Recreating foreign keys for ${deployment.title}...`)
    await rebuildForeignKeys(deployment);
}

// npm run build (deployment)
// npm run watch (deployment)
// npm run publish (deployment)
//   Triggers npm ci, npm prune, then npm run build/watch/publish
//
//   params:
//   deployment (optional) - deployment key, falls back to the first deployment in deployments.json
export async function triggerNPM() {
    let selected_cmd = 'build';
    if (process.argv.includes('watch')) { selected_cmd = 'watch'; }
    if (process.argv.includes('publish')) { selected_cmd = 'publish'; }

    const deployment = getDeployment(process.argv[process.argv.indexOf(selected_cmd) + 1], true);

    console.log(`Installing NPM dependencies and running ${selected_cmd} script for ${deployment.title}...`)
    await rebuildNPM(deployment, selected_cmd);
}

require('make-runnable/custom')({
    printOutputFrame: false
})
