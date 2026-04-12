import chalk from 'chalk';
import inquirer from 'inquirer';
import { start, stop, } from '../functions/docker';
import { runDatabaseMigrations } from '../functions/migrate';
import { getDeploymentFromArgs, checkUpToDate } from './utils';

/**
 * Interactive CLI tool
 *
 * Runs any new migration scripts in the updates folder
 * Optionally rebuild the instance before running migrations
 */
async function main() {
    if (!(await checkUpToDate())) return;
    const deployment = getDeploymentFromArgs();

    console.info(chalk.blue(`\nRunning migrations on ${deployment.title}...`));

    const answer = await inquirer.prompt({
        type: 'confirm',
        name: 'build',
        message: 'Should the instance be rebuilt before running migrations? (docker compose up --build)',
        default: true,
    });

    // build if necessary
    if (answer.build) {
        console.info(chalk.yellow('Rebuilding instance...'));
        const stopResult = await stop(deployment);
        if (stopResult.error) {
            throw stopResult.error;
        }

        const startResult = await start(deployment, true);
        if (startResult.error) {
            throw startResult.error;
        }
    }

    // migrate
    const result = await runDatabaseMigrations(deployment);
    if (result.error) {
        return;
    }

    console.info(chalk.green(`Done!`));
}

main();
