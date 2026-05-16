import * as Sentry from "@sentry/node";
import { nodeProfilingIntegration } from "@sentry/profiling-node";
import { config } from "./config"

if (config.SENTRY_DSN) {
    Sentry.init({
        dsn: config.SENTRY_DSN,
        integrations: [
            nodeProfilingIntegration(),
        ],
        tracesSampleRate: 1.0,
        profilesSampleRate: 1.0,
        sendDefaultPii: true,
        enableLogs: true,
    });
}
