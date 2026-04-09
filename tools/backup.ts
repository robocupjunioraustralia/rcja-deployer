import chalk from 'chalk';
import { createDatabaseBackup } from '../functions/backup';
import { getDeploymentFromArgs, checkUpToDate } from './utils';

/**
 * Interactive CLI tool
 *
 * Create a backup of the deployment's databases
 */
async function main() {
    if (!(await checkUpToDate())) return;
    const deployment = getDeploymentFromArgs();

    console.info(chalk.blue(`\nCreating backup for ${deployment.title}...`));

    const { result, backupFile } = await createDatabaseBackup(deployment);
    if (result.error) {
        throw result.error;
    }

    console.log(chalk.green(`Backup created successfully: ${backupFile}`));
}

main();
