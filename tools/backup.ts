import chalk from 'chalk';
import { createDatabaseBackup } from '../functions/backup';
import { getDeploymentFromArgs, checkUpToDate } from './utils';

/**
 * Interactive CLI tool
 *
 * Create a backup of the deployment's databases
 *
 * Arguments:
 * --anonymise: Whether to anonymise the backup (default: false)
 */
async function main() {
    if (!(await checkUpToDate())) return;
    const deployment = getDeploymentFromArgs();
    const anonymise = process.argv.includes('--anonymise');

    console.info(chalk.blue(`\nCreating ${anonymise ? 'anonymised ' : ''}backup for ${deployment.title}...`));


    const { result, backupFile } = await createDatabaseBackup(deployment, anonymise);
    if (result.error) {
        throw result.error;
    }

    console.log(chalk.green(`Backup created successfully: ${backupFile}`));
}

main();
