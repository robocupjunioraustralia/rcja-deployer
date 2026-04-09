import { checkUpToDate } from './utils';
import { getDeployment } from '../functions/deployment';
import { runSyncDatabases } from '../functions/syncDatabases';
import { config } from '../config';

/**
 * Interactive CLI tool
 *
 * Syncronises the production database to the development database
 * uses env.SYNC_FROM_DEPLOYMENT and env.SYNC_TO_DEPLOYMENT to determine which deployments to sync
 */
async function main() {
    if (!(await checkUpToDate())) return;
    const fromDeployment = getDeployment(config.SYNC_FROM_DEPLOYMENT, true);
    const toDeployment = getDeployment(config.SYNC_TO_DEPLOYMENT, true);

    console.info(`Syncronising databases from ${fromDeployment.title} to ${toDeployment.title}...`);
    await runSyncDatabases(fromDeployment, toDeployment);
}

main();
