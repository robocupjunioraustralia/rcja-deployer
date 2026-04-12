import chalk from 'chalk';
import inquirer from 'inquirer';
import { checkUpToDate } from './utils';
import { getDeployment } from '../functions/deployment';
import { syncDatabases } from '../functions/syncDatabases';
import { config } from '../config';

/**
 * Interactive CLI tool
 *
 * Syncronise the databases between two different instances
 * Uses env.SYNC_FROM_DEPLOYMENT and env.SYNC_TO_DEPLOYMENT to determine which deployments to sync
 */
async function main() {
    if (!(await checkUpToDate())) return;
    const source = getDeployment(config.SYNC_FROM_DEPLOYMENT, true);
    const target = getDeployment(config.SYNC_TO_DEPLOYMENT, true);

    console.info(chalk.redBright(`\n[WARNING] This will overwrite all existing databases on ${target.title}`));
    const { confirm } = await inquirer.prompt<{ confirm: string }>([
        {
            type: 'input',
            name: 'confirm',
            message: `Are you sure you want to continue? Write 'confirm' to confirm.`,
        }
    ]);

    if (confirm !== 'confirm') {
        console.info(chalk.yellow(`\n[DEPLOYER] Sync cancelled.`));
        return;
    }

    const result = await syncDatabases(source, target);
    if (result.error) {
        return;
    }

    console.info(chalk.green(`Done!`));
}

main();
