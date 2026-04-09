
import chalk from 'chalk';
import fs from 'fs';
import inquirer from 'inquirer';
import os from 'os';
import path from "path";
import { Readable } from 'stream';
import { finished } from 'stream/promises';
import unzipper from 'unzipper';
import { getDeploymentBackupDir } from "../functions/backup";
import type { ApiBackupResult } from "../functions/backup";
import { getDeployment } from '../functions/deployment';
import { runImportDatabases } from '../functions/importDatabases';
import { checkUpToDate } from './utils';

/**
 * Interactive CLI tool
 *
 * Imports a database backup to a deployment
 * CAUTION: This will overwrite the target databases
 */
async function main() {
    if (!(await checkUpToDate())) {
        return;
    }

    const deployment = getDeployment(process.argv[process.argv.length - 1], true);

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

            const backupData = await backupResponse.json() as ApiBackupResult;
            backupName = backupData.name;
        }

        console.log(`\n[DEPLOYER] Retrieving backup "${backupName}" from ${remoteUrlBase}...`);

        const exportResponse = await fetch(`${remoteUrlBase}/${backupName}`, { headers: remoteHeaders });
        if (!exportResponse.ok || exportResponse.body === null) {
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

        const backupDirPath = path.join(deploymentBackupDir, selectedBackup.backupDir);
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

main();
