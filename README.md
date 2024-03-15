# RCJCMS Deployer

This is a tool used for managing deployments of the RCJCMS (https://github.com/robocupjunior/rcj_cms)

## Required Software

The following software is required for the various functions of this tool to work, they essentially match the RCJCMS requirements.\
*Listed versions are the minimum required version, later versions may also work.*
- NodeJS (https://nodejs.org/en/download) `20.x.x LTS`
- PHP (https://www.php.net/downloads) `8.2`
- MariaDB (https://mariadb.org/download) `10.6` (Including MySQL/MariaDB Dump)
- Composer (https://getcomposer.org/download) `2.5`


## Installation

1. Install the required software
1. Clone the repository: `git clone https://github.com/robocupjunioraustralia/rcja-deployer.git`
1. Change to the location you cloned the above repo `cd rcja-deployer`
1. Install dependencies, by running the following command in CMD/Terminal etc.: `npm install`

## Configuration

### .env

- The `.env` file contains sensitive information and should not be committed to the repository.
- Copy the contents of `.env.example` to a new `.env`, then populate it with your own settings. 

The following variables must be set for the deployment scripts to work.
| Variable | Description |
| --- | --- |
| DB_HOST<br>DB_USER<br>DB_PASSWORD | Details for the MariaDB server with a working instance of the RCJCMS |
| DB_CACHE_NAME | Required for the anonymise function.<br>The name of the MySQL database to use for caching names.<br>If you wish to use this, create an empty database using the specificed name, and populate it using the schema in db.sql. |
| | |
| NPM_PATH<br>PHP_PATH<br>MYSQL_PATH<br>MYSQLDUMP_PATH<br>COMPOSER_PATH | The paths to your npm, php, mysql, mysqldump, and composer executables.<br>There are some suggestions in the sample file for windows/linux |

Some other variables of note include: (these are only required if you want to run the full server with `npm start`)
| Variable | Description |
| --- | --- |
| DEPLOY_SECRET | Secret used for authenticating requests from GitHub |
| SMTP_* | Email configuration details for deployment alerts |
| SYNC_FROM_DEPLOYMENT<br>SYNC_TO_DEPLOYMENT | The deployment to sync from and to.<br>This is used by the full server to sync the staging server with production each night |
| ANON_PASSWORD | The (unhashed) password that will be set for every user after anonymisation. This may be useful for testing. It isn't required. |
| REGO_DEPLOY_SCRIPT | Path to the rego deploy script, e.g. /home/apps/rcja-registration/deploy.sh |
| REGO_DEPLOY_SECRET | Secret used for authenticating requests from rego GitHub |
| SENTRY_DSN | The sentry DSN used when initialising Sentry |

### deployments.json

- The `deployments.json` file contains information about each deployment on your system.\
During development, this would normally only have one entry.

The sample included is meant for a full deployment, for a development instance on Windows using XAMPP, something like the following could be used:
```json
{
    "develop" : {
        "title": "RCJCMS - Development",
        "path": "C:/xampp/htdocs/rcj_cms/",
        "migration_folder": "updates",
        "database_prefix": "rcj_cms",
        "repository": "robocupjunioraustralia/rcj_cms",
        "pull_cmd": "git fetch --all && git pull git status",
        "build_cmd": "build",
        "backup": true,
        "run_nightly": true,
        "branch_ref": "refs/heads/develop",
    }
}
```

Here's a quick explanation of each variable:
| Variable | Description |
| --- | --- |
| *title | The name of the deployment |
| *path | The local path to the deployment files |
| *migration_folder | The folder containing database migration scripts |
| *database_prefix | The prefix of the MySQL databases used by the deployment |
| *repository | The GitHub repository containing the deployment files |
| *pull_cmd | The command to use to pull latest changes from the repository |
| *build_cmd | The npm script to build assets, "build" (dev) or "publish" (prod) |
| backup | Whether or not to backup the database before running migrations |
| run_nightly | Whether or not to run the nightly script on this deployment |
| branch_ref | The git ref for confirming the branch sent from the the webhook |


---

## Usage

### **Start the server** *(For Production)*
```
npm start
```

- This starts the full server and listens for incoming deployment requests. Make sure all configuration is setup \
This also creates a cronjob for each night at 12PM to sync a prod database to staging

---

### **Useful Scripts** *(For Development/Testing)*

You can use these commands to assist you while developing.
For instance, if you have recieved new changes from develop, it is a good idea to run the `npm run update` command to make sure your database is up to date.

Append a deployment key to the end of any of these to change the deployment the command will target. Otherwise, it will just choose the first one alphabetically. For example, `npm run update [deployment]`

---

### "All-in-one" Interactive Script

```
npm run update
```

The most common command you should run during development. This tool allows you to:
- Run any new migration scripts
- Rebuild all views
- Install NPM dependencies
- Build assets, or actively watch for changes

When you pull down changes from the repository, this script will help you ensure your database is up to date and all CSS/JS/etc assets are built correcly.

Keep the watch script running whilst you are developing as this will automatically rebuild assets when you change them.

---

### Other Commands
#### Install NPM Dependencies and build assets

There are 3 modes for building assets that you can choose from:
- `npm run watch` - Builds the frontend for development and watches for changes *(recommended for development)*
- `npm run build` - Builds the frontend once for development
- `npm run publish` - Builds the frontend once for production

#### Database Tools

```sh
npm run migrate # Runs any new migration scripts in the updates folder.
npm run rebuildViews # Rebuilds all views in the database.
npm run rebuildForeignKeys # Rebuilds all foreign keys in the database.
npm run rebuildUsers # Rebuilds all users in the database.
npm run anonymise # Anonymises the database.
npm run syncDatabases # Syncronises the production database to the development database (env.SYNC_FROM_...)
```
