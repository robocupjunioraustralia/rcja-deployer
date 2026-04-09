import chalk from 'chalk';
import { getDeploymentFromArgs, checkUpToDate } from './utils';
import { anonymiseDatabase } from '../functions/anonymiseDatabase';

/**
 * Interactive CLI tool
 *
 * Anonymises the databases for a deployment
 */
async function main() {
    if (!(await checkUpToDate())) return;
    const deployment = getDeploymentFromArgs();

    console.info(chalk.blue(`\nAnonymising ${deployment.title}...`));
    await anonymiseDatabase(deployment);
}

main();
