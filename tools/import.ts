import chalk from 'chalk';
import fs from 'fs';
import inquirer from 'inquirer';
import path from "path";
import { Readable } from 'stream';
import { finished } from 'stream/promises';
import { getDeploymentBackupDir } from "../functions/backup";
import type { ApiBackupResult } from "../functions/backup";
import { checkUpToDate, getDeploymentFromArgs } from './utils';
import { importBackup } from '../functions/docker';

/**
 * Interactive CLI tool
 *
 * Imports a database backup to a deployment
 * CAUTION: This will overwrite the target databases
 */
async function main() {
    if (!(await checkUpToDate())) return;
    const deployment = getDeploymentFromArgs();

    let hasConfirmed = false;
    async function promptContinue() {
        if (hasConfirmed) {
            return true;
        }

        console.log(chalk.redBright(`\n[WARNING] This will delete all existing local databases for this deployment`));
        const importConfirmed = await inquirer.prompt<{ confirm: string }>([
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

    const { importSource } = await inquirer.prompt<{ importSource: 'local-backup' | 'local-sql' | 'remote' }>([
        {
            type: 'rawlist',
            name: 'importSource',
            message: `Select the import source to use:`,
            choices: [
                { name: `Local - Backup created by the deployer in ./backups/${deployment.database_prefix}`, value: 'local-backup' },
                { name: 'Local - .tar.gz of SQL files on the local machine', value: 'local-sql' },
                { name: 'Remote - Import a backup from a remote deployment', value: 'remote' },
            ],
        }
    ]);

    let backupFile: string | null = null;

    if (importSource === 'remote') {
        if (!deployment.import) {
            console.error(chalk.red(`\n[DEPLOYER] Remote import is not configured in deployments.json for ${deployment.title}`));
            return;
        }

        const { remoteImportSource } = await inquirer.prompt<{ remoteImportSource: 'latest' | 'custom' | 'new' }>([
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

        let backupName: string | null = null;
        if (remoteImportSource === 'latest') {
            backupName = 'latest';
        } else if (remoteImportSource === 'custom') {
            const { customBackupName } = await inquirer.prompt<{ customBackupName: string }>([
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

        const formattedDate = new Date().toISOString().replaceAll(':', '-').split('.')[0];
        const backupDir = getDeploymentBackupDir(deployment, true);
        backupFile = path.join(backupDir, `${formattedDate}_remote.tar.gz`);

        const fileStream = fs.createWriteStream(backupFile);
        await finished(Readable.fromWeb(exportResponse.body).pipe(fileStream));

        console.log(`[DEPLOYER] Downloaded backup to ${backupFile}`);
    } else if (importSource === 'local-backup') {
        const deploymentBackupDir = getDeploymentBackupDir(deployment, false);
        if (!deploymentBackupDir) {
            console.error(chalk.red(`[DEPLOYER] No backups found for deployment "${deployment.title}"`));
            return;
        }

        const backupFiles = fs.readdirSync(deploymentBackupDir, { withFileTypes: true })
            .filter((file) => file.isFile() && file.name.endsWith('.tar.gz'))
            .sort()
            .reverse();

        const selectedBackup = await inquirer.prompt<{ backupFile: string }>([
            {
                type: 'rawlist',
                name: 'backupFile',
                message: `Select a backup to import:`,
                choices: backupFiles,
            }
        ]);

        backupFile = path.join(deploymentBackupDir, selectedBackup.backupFile);
    } else if (importSource === 'local-sql') {
        console.log(" ");
        console.log(chalk.yellow(`[INFO] Make sure the .tar.gz file contains SQL table dumps named main.sql & comp_[eventId].sql`));
        console.log(chalk.yellow(`[INFO] Each SQL table dump should not contain CREATE DATABASE or USE statements`));

        const answers = await inquirer.prompt<{ backupFile: string }>([
            {
                type: 'input',
                name: 'backupFile',
                message: `Path to .tar.gz backup file for ${deployment.database_prefix}:`,
            }
        ]);

        backupFile = answers.backupFile;
    }

    /** Make sure the file exists */
    console.info(" ");
    if (backupFile === null || !fs.existsSync(backupFile)) {
        console.error(chalk.red(`[DEPLOYER] Backup file not found: ${backupFile}`));
        return;
    }

    if (!backupFile.endsWith('.tar.gz')) {
        console.error(chalk.red(`[DEPLOYER] Invalid backup file type. Expected .tar.gz`));
        return;
    }

    if (!(await promptContinue())) {
        console.info(chalk.yellow(`\n[DEPLOYER] Import cancelled.`));
        return;
    }

    console.info("\n");

    console.info(chalk.blue(`[DEPLOYER] Importing databases from ${path.basename(backupFile)} to ${deployment.title}...`))
    const backupFileStream = fs.createReadStream(backupFile);
    const importResult = await importBackup(deployment, backupFileStream);
    if (importResult.error) {
        throw importResult.error;
    }

    console.info(chalk.green(`Done!`));
    console.info(chalk.cyan(`[INFO] You may wish to run 'npm run update' next`));
}

main();
