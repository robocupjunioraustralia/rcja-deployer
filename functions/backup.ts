import path from "path";
import fs from 'fs';
import type { Deployment, DeploymentExecResult } from './deployment';
import { backup } from './docker';

export function getDeploymentBackupDir(deployment: Deployment, makeIfMissing: true): string;
export function getDeploymentBackupDir(deployment: Deployment, makeIfMissing: false): string | null;
export function getDeploymentBackupDir(deployment: Deployment, makeIfMissing: boolean): string | null {
    const backupFolder = path.join(__dirname, '../backups');
    if (!fs.existsSync(backupFolder)) {
        if (!makeIfMissing) {
            return null;
        }
        fs.mkdirSync(backupFolder);
    }

    const deploymentBackupFolder = path.join(backupFolder, deployment.database_prefix);
    if (!fs.existsSync(deploymentBackupFolder)) {
        if (!makeIfMissing) {
            return null;
        }
        fs.mkdirSync(deploymentBackupFolder);
    }

    return deploymentBackupFolder;
}

/**
 * Create a backup of the deployment's databases
 * @param deployment target
 * @param suffix optional suffix to add to the backup's name
 * @returns
 */
export async function createDatabaseBackup(deployment: Deployment, suffix = ""): Promise<{
    result: DeploymentExecResult;
    backupName: string;
    backupDir: string;
    backupFile: string
}> {
    const backupName = new Date().toISOString().replaceAll(':', '-').split('.')[0] + suffix;

    const backupDir = getDeploymentBackupDir(deployment, true);
    const backupFile = path.join(backupDir, `${backupName}.tar.gz`);

    const backupFileStream = fs.createWriteStream(backupFile);
    const backupResult = await backup(deployment, backupFileStream);

    return {
        result: backupResult,
        backupName,
        backupDir,
        backupFile
    }
}

export type ApiBackupResult = {
  name: string;
}
