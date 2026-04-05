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

    /** Database configuration for all RCJ CMS deployments */
    DB_HOST: string;
    DB_USER: string;
    DB_PASSWORD: string;

    /**
     * Required for the anonymise function.
     * The name of the MySQL database to use for caching names.
     * If you wish to use this, create an empty database using the specificed name, and populate it using the schema in db.sql
     */
    DB_CACHE_NAME?: string;
    /** The (unhashed) password that will be set for every user after anonymisation. This may be useful for testing. It isn't required. */
    ANON_PASSWORD: string;

    /** Paths to required executables */
    NPM_PATH: string;
    PHP_PATH: string;
    MYSQL_PATH: string;
    MYSQLDUMP_PATH: string;

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
