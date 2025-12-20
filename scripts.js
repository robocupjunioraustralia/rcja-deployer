// Runner for command-line scripts

const { exec } = require('child_process');
const dotenv = require("dotenv");
const path = require("path");
const fs = require('fs');
const inquirer = require('inquirer');
const chalk = require('chalk');

const { rebuildViews } = require('./functions/rebuildViews');
const { runSyncDatabases } = require('./functions/syncDatabases');
const { runImportDatabases } = require('./functions/importDatabases');
const { anonymiseDatabase } = require('./functions/anonymiseDatabase');
const { rebuildForeignKeys } = require('./functions/rebuildForeignKeys');
const { runDatabaseMigrations } = require('./functions/migrate');
const { rebuildUsers } = require('./functions/rebuildUsers');
const { rebuildNPM } = require('./functions/rebuildNPM');

dotenv.config();

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

/**
 * Retrieve deployment config for a given deployment name, or the first deployment if none is given
 * @param {string} deploymentName - Name of the deployment to retrieve
 * @returns {object|null} - Deployment config, or null if not found
 */
function getDeploymentConfig(deploymentName) {
    const deployments = JSON.parse(fs.readFileSync(path.join(__dirname, 'deployments.json'), 'utf8'));

    if (deploymentName === undefined) {
        return deployments[Object.keys(deployments)[0]];
    }

    const deploymentConfig = deployments[deploymentName];

    if (!deploymentConfig) {
        console.error(`Deployment ${deploymentName} not found in deployments.json`);
        return null;
    }

    return deploymentConfig;
}

// npm run update (deployment)
//   Interactive script to update a deployment
//
//   params:
//   deployment (optional) - name of deployment in deployments.json, defaults to first deployment in deployments.json
async function triggerUpdate() {
    if (!(await checkUpToDate())) {
        return;
    }

    const selected_deployment = getDeploymentConfig(process.argv[process.argv.indexOf('update') + 1]);
    if (!selected_deployment) {
        return;
    }

    console.log(chalk.blue(`[DEPLOYER] Updating ${selected_deployment.title}...`));
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
        await rebuildNPM(selected_deployment, 'build', true);

        console.log(chalk.blue(`[DEPLOYER] Running migrations on ${selected_deployment.title}...`))
        const [migrateFailed, migrateLog] = await runDatabaseMigrations(
            selected_deployment,
            !selected_deployment.backup,
            selected_deployment.no_composer_dev || user_answers.npm_command === 'publish',
        );
        if (migrateFailed) {
            console.error(chalk.red(`[DEPLOYER] Failed to run migrations on ${selected_deployment.title}`));
            return;
        }
    }

    if (user_answers.rebuild_views) {
        console.log(chalk.blue(`[DEPLOYER] Rebuilding views on ${selected_deployment.title}...`))
        await rebuildViews(selected_deployment);
    }

    console.log(chalk.blue(`[DEPLOYER] Installing NPM dependencies and running ${user_answers.npm_command} script for ${selected_deployment.title}...`))
    await rebuildNPM(selected_deployment, user_answers.npm_command);
}


// npm run import (deployment)
//   Interactive script to import databases to a deployment
//   CAUTION: This will overwrite the target databases
//
//   params:
//   deployment (optional) - name of deployment in deployments.json, defaults to first deployment in deployments.json
async function triggerImport() {
    if (!(await checkUpToDate())) {
        return;
    }

    const selected_deployment = getDeploymentConfig(process.argv[process.argv.indexOf('import') + 1]);
    if (!selected_deployment) {
        return;
    }

    console.log(chalk.blue(`[DEPLOYER] Import databases (${selected_deployment.title})`));
    console.log(chalk.cyan(`[INFO] This tool allows you to restore your deployment's databases from a backup`));
    console.log(" ");

    const { importSource } = await inquirer.prompt([
        {
            type: 'rawlist',
            name: 'importSource',
            message: `Select the import source to use:`,
            choices: [
                { name: 'Local - Backup created by the deployer in ./backups', value: 'local-backup' },
                { name: 'Local - SQL files on the local machine', value: 'local-sql' },
            ],
        }
    ]);

    const mainFiles = [];
    const compFiles = [];

    if (importSource === 'local-backup') {
        const backupsPath = path.join(__dirname, 'backups');
        if (!fs.existsSync(backupsPath)) {
            console.error(chalk.red(`[DEPLOYER] No backups found in ./backups`));
            return;
        }

        const backupFiles = fs.readdirSync(backupsPath).filter(
            (file) => fs.lstatSync(path.join(__dirname, 'backups', file)).isDirectory()
        ).sort().reverse();

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

            if (file.startsWith(`${selected_deployment.database_prefix}_main`)) {
                mainFiles.push(path.join(backupDirPath, file));
            }

            if (file.startsWith(`${selected_deployment.database_prefix}_comp`)) {
                compFiles.push(path.join(backupDirPath, file));
            }
        }
    } else if (importSource === 'local-sql') {
        console.log(" ");
        console.log(chalk.yellow(`[INFO] Make sure each SQL dump file has the database prefix of '${selected_deployment.database_prefix}'`));

        const answers = await inquirer.prompt([
            {
                type: 'input',
                name: 'mainDBFile',
                message: `Path to SQL dump for ${selected_deployment.database_prefix}_main:`,
            },
            {
                type: 'input',
                name: 'compDBFile',
                message: `Path to SQL dump for ${selected_deployment.database_prefix}_comp:`,
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

    console.log(chalk.redBright(`\n[WARNING] This will delete all existing databases for this deployment`));
    const importConfirmed = await inquirer.prompt([
        {
            type: 'input',
            name: 'confirm',
            message: `Are you sure you want to continue? Write 'delete' to confirm.`,
        }
    ]);

    if (importConfirmed.confirm !== 'delete') {
        console.log(chalk.yellow(`\n[DEPLOYER] Import cancelled.`));
        return;
    }

    console.log("\n");

    console.log(chalk.blue(`[DEPLOYER] Importing databases to ${selected_deployment.title}...`))
    const [importFailed, importLog] = await runImportDatabases(
        selected_deployment,
        mainDBFile,
        compDBFile
    );
    if (importFailed) {
        console.error(chalk.red(`[DEPLOYER] Failed to import databases to ${selected_deployment.title}`));
        return;
    }

    console.log(chalk.green(`\n\nDone!`));
    console.log(chalk.cyan(`[INFO] If this is a development environment, you may wish to run 'npm run update' next`));
}

// npm run migrate (deployment)
//   Runs any new migration scripts in the updates folder
//
//   params:
//   deployment (optional) - name of deployment in deployments.json, defaults to first deployment in deployments.json
async function triggerMigrate() {
    const deployments_info = JSON.parse(fs.readFileSync(path.join(__dirname, 'deployments.json'), 'utf8'));
    let selected_deployment = deployments_info[Object.keys(deployments_info)[0]];

    // if deployment is not specified, set selected deployment to first deployment in deployments.json
    if (process.argv[process.argv.indexOf('migrate') + 1] !== undefined) {
        const deployment = process.argv[process.argv.indexOf('migrate') + 1];
        const deployment_info = deployments_info[deployment];

        if (deployment_info) {
            selected_deployment = deployment_info;
        } else {
            console.error(`Deployment ${deployment} not found in deployments.json`);
            return;
        }
    }

    console.log(`Running migrations on ${selected_deployment.title}...`)
    const [migrateFailed, migrateLog] = await runDatabaseMigrations(
        selected_deployment,
        !selected_deployment.backup,
        selected_deployment.no_composer_dev || false,
    );

    if (migrateFailed) {
        console.error(`Failed to run migrations on ${selected_deployment.title}`);
        return;
    }

    console.log(`Rebuilding views on ${selected_deployment.title}...`)
    await rebuildViews(selected_deployment);
    console.log(`\n\nDone!`)
}

// npm run rebuildViews (deployment)
//   Rebuilds all views in the database
//
//   params:
//   deployment (optional) - name of deployment in deployments.json, defaults to first deployment in deployments.json
async function triggerRebuildViews() {
    const deployments_info = JSON.parse(fs.readFileSync(path.join(__dirname, 'deployments.json'), 'utf8'));
    let selected_deployment = deployments_info[Object.keys(deployments_info)[0]];

    // if deployment is not specified, set selected deployment to first deployment in deployments.json
    if (process.argv[process.argv.indexOf('rebuildViews') + 1] !== undefined) {
        const deployment = process.argv[process.argv.indexOf('rebuildViews') + 1];
        const deployment_info = deployments_info[deployment];

        if (deployment_info) {
            selected_deployment = deployment_info;
        } else {
            console.error(`Deployment ${deployment} not found in deployments.json`);
            return;
        }
    }

    console.log(`Rebuilding views on ${selected_deployment.title}...`)
    await rebuildViews(selected_deployment);
}

// npm run anonymise (deployment)
//   Anonymises the database
//
//   params:
//   deployment (optional) - name of deployment in deployments.json, defaults to first deployment in deployments.json
async function triggerAnonymise() {
    const deployments_info = JSON.parse(fs.readFileSync(path.join(__dirname, 'deployments.json'), 'utf8'));
    let selected_deployment = deployments_info[Object.keys(deployments_info)[0]];

    // if deployment is not specified, set selected deployment to first deployment in deployments.json
    if (process.argv[process.argv.indexOf('anonymise') + 1] !== undefined) {
        const deployment = process.argv[process.argv.indexOf('anonymise') + 1];
        const deployment_info = deployments_info[deployment];

        if (deployment_info) {
            selected_deployment = deployment_info;
        } else {
            console.error(`Deployment ${deployment} not found in deployments.json`);
            return;
        }
    }

    console.log(`Anonymising ${selected_deployment.title}...`)
    await anonymiseDatabase(selected_deployment);
}

// npm run syncDatabases (deployment)
//   Syncronises the production database to the development database
//   uses env.SYNC_FROM_DEPLOYMENT and env.SYNC_TO_DEPLOYMENT to determine which deployments to sync
async function triggerSyncDatabases() {
    const deployments_info = JSON.parse(fs.readFileSync(path.join(__dirname, 'deployments.json'), 'utf8'));
    const fromDeployment = deployments_info[process.env.SYNC_FROM_DEPLOYMENT];
    const toDeployment = deployments_info[process.env.SYNC_TO_DEPLOYMENT];
    console.log(`Syncronising deployments...`)
    await runSyncDatabases(fromDeployment, toDeployment);
}

// npm run rebuildUsers (deployment)
//   Rebuilds all users for a database
//
//   params:
//   deployment (optional) - name of deployment in deployments.json, defaults to first deployment in deployments.json
async function triggerRebuildUsers() {
    const deployments_info = JSON.parse(fs.readFileSync(path.join(__dirname, 'deployments.json'), 'utf8'));
    let selected_deployment = deployments_info[Object.keys(deployments_info)[0]];

    // if deployment is not specified, set selected deployment to first deployment in deployments.json
    if (process.argv[process.argv.indexOf('rebuildUsers') + 1] !== undefined) {
        const deployment = process.argv[process.argv.indexOf('rebuildUsers') + 1];
        const deployment_info = deployments_info[deployment];

        if (deployment_info) {
            selected_deployment = deployment_info;
        } else {
            console.error(`Deployment ${deployment} not found in deployments.json`);
            return;
        }
    }

    console.log(`Recreating Users for ${selected_deployment.title}...`)
    await rebuildUsers(selected_deployment);
}

// npm run rebuildForeignKeys (deployment)
//   Rebuilds all foriegn keys in the database
//
//   params:
//   deployment (optional) - name of deployment in deployments.json, defaults to first deployment in deployments.json
async function triggerRebuildForeignKeys() {
    const deployments_info = JSON.parse(fs.readFileSync(path.join(__dirname, 'deployments.json'), 'utf8'));
    let selected_deployment = deployments_info[Object.keys(deployments_info)[0]];

    // if deployment is not specified, set selected deployment to first deployment in deployments.json
    if (process.argv[process.argv.indexOf('rebuildForeignKeys') + 1] !== undefined) {
        const deployment = process.argv[process.argv.indexOf('rebuildForeignKeys') + 1];
        const deployment_info = deployments_info[deployment];

        if (deployment_info) {
            selected_deployment = deployment_info;
        } else {
            console.error(`Deployment ${deployment} not found in deployments.json`);
            return;
        }
    }

    console.log(`Recreating foreign keys for ${selected_deployment.title}...`)
    await rebuildForeignKeys(selected_deployment);
}

// npm run build (deployment)
// npm run watch (deployment)
// npm run publish (deployment)
//   Triggers npm ci, npm prune, then npm run build/watch/publish
//
//   params:
//   deployment (optional) - name of deployment in deployments.json, defaults to first deployment in deployments.json
async function triggerNPM() {
    let selected_cmd = 'build';
    if (process.argv.includes('watch')) { selected_cmd = 'watch'; }
    if (process.argv.includes('publish')) { selected_cmd = 'publish'; }

    const deployments_info = JSON.parse(fs.readFileSync(path.join(__dirname, 'deployments.json'), 'utf8'));
    let selected_deployment = deployments_info[Object.keys(deployments_info)[0]];

    // if deployment is not specified, set selected deployment to first deployment in deployments.json
    if (process.argv[process.argv.indexOf(selected_cmd) + 1] !== undefined) {
        const deployment = process.argv[process.argv.indexOf(selected_cmd) + 1];
        const deployment_info = deployments_info[deployment];

        if (deployment_info) {
            selected_deployment = deployment_info;
        } else {
            console.error(`Deployment ${deployment} not found in deployments.json`);
            return;
        }
    }

    console.log(`Installing NPM dependencies and running ${selected_cmd} script for ${selected_deployment.title}...`)
    await rebuildNPM(selected_deployment, selected_cmd);
}

module.exports = {
    update: triggerUpdate,
    import: triggerImport,
    migrate: triggerMigrate,
    rebuildViews: triggerRebuildViews,
    anonymise: triggerAnonymise,
    syncDatabases: triggerSyncDatabases,
    rebuildUsers: triggerRebuildUsers,
    rebuildForeignKeys: triggerRebuildForeignKeys,
    build: triggerNPM,
    watch: triggerNPM,
    publish: triggerNPM,
};

require('make-runnable/custom')({
    printOutputFrame: false
})
