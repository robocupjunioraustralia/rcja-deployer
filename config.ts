import dotenv from 'dotenv';
const { parsed } = dotenv.config();

type Env = {
    /** Port for the web server to listen on */
    HTTP_PORT: number | string;
    /** Authorization secret matching the 'x-hub-signature' header from a GitHub webhook */
    DEPLOY_SECRET: string;

    /** Email configuration details for deployment alerts */
    SMTP_HOST?: string;
    SMTP_PORT?: number | string;
    SMTP_SECURE?: boolean | string;
    SMTP_USER?: string;
    SMTP_PASSWORD?: string;
    SMTP_FROM?: string;
    SMTP_TO?: string;

    /** A Sentry DSN if using Sentry for error reporting */
    SENTRY_DSN?: string;

    /** When using the sync function, the deployment key to sync from */
    SYNC_FROM_DEPLOYMENT: string;
    /** When using the sync function, the deployment key to sync to */
    SYNC_TO_DEPLOYMENT: string;

    /** Path to the rego deploy script, e.g. /home/apps/rcja-registration/deploy.sh */
    REGO_DEPLOY_SCRIPT: string;
    /** Working directory to use when running the rego deploy script */
    REGO_DEPLOY_PATH: string;
    /** Expected Authorization header value for triggering a rego deployment */
    REGO_DEPLOY_SECRET: string;
}

export const config: Env = parsed as unknown as Env;
