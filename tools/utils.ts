import { execFile } from 'child_process';
import inquirer from 'inquirer';
import { getDeployment } from '../functions/deployment';
import type { Deployment } from '../functions/deployment';

/**
 * @returns the deployment from the command line args, or the first deployment if no args provided
 */
export function getDeploymentFromArgs(): Deployment {
    const deploymentKey = process.argv.slice(2).find((arg) => !arg.startsWith('-')) ?? undefined;
    return getDeployment(deploymentKey, true);
}

/**
 * Execute a git command
 * @param args arguments for git
 * @returns stdout
 */
function execGit(args: string[]): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        execFile('git', args, (error, stdout, stderr) => {
            if (error) {
                reject(new Error((stderr || error.message).toString().trim()));
                return;
            }

            resolve(stdout.toString().trim());
        });
    });
}

/**
 * Check that the deployer is up to date before proceeding
 * @returns true if up to date, or if the user chooses to continue anyway
 */
export async function checkUpToDate(): Promise<boolean> {
    await execGit(['fetch', '--quiet']);
    const aheadBehind = await execGit(['rev-list', '--left-right', '--count', 'origin/main...HEAD']);
    const [behind, ahead] = aheadBehind.split(/\s+/).map((x) => Number.parseInt(x, 10));

    if (behind === 0 && ahead === 0) {
        return true;
    }

    const answer = await inquirer.prompt({
        type: 'confirm',
        name: 'continue',
        message: `Your deployer is not up to date (behind: ${behind}, ahead: ${ahead}). You should run 'git pull' first. Continue anyway?`,
        default: false,
    });

    return answer.continue;
}
