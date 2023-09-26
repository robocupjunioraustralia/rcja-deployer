// Runner for command-line scripts

const { exec } = require('child_process');
const express = require("express");
const bodyParser = require("body-parser");
const morgan = require("morgan");
const dotenv = require("dotenv");
const path = require("path");
const crypto = require('crypto');
const fs = require('fs');
const nodemailer = require('nodemailer');

const { rebuildViews } = require('./functions/rebuildViews');
const { runSyncDatabases } = require('./functions/syncDatabases');
const { anonymiseDatabase } = require('./functions/anonymiseDatabase');
const { rebuildForeignKeys } = require('./functions/rebuildForeignKeys');
const { createDatabaseBackup } = require('./functions/backup');
const { runDatabaseMigrations } = require('./functions/migrate');
const { rebuildUsers } = require('./functions/rebuildUsers');
const { enableMaintenance, disableMaintenance } = require('./functions/maintenance');
const { rebuildNPM } = require('./functions/rebuildNPM');

dotenv.config();

// npm run migrate (deployment)
//   Runs any new migration scripts in the updates folder
// 
//   params: 
//   deployment (optional) - name of deployment in deployments.json, defaults to first deployment in deployments.json
async function triggerMigrate() {
    const deployments_info = JSON.parse(fs.readFileSync(path.join(__dirname, 'deployments.json'), 'utf8'));
    let selected_deployment = deployments_info[Object.keys(deployments_info)[0]];

    // if deployment is not specified, set selected deployment to first deployment in deployments.json
    if (process.argv[process.argv.indexOf('migrate') + 1] !== undefined) {
        const deployment = process.argv[process.argv.indexOf('migrate') + 1];
        const deployment_info = deployments_info[deployment];
        
        if (deployment_info) {
            selected_deployment = deployment_info;
        } else {
            console.error(`Deployment ${deployment} not found in deployments.json`);
            return;
        }
    }
    
    console.log(`Running migrations on ${selected_deployment.title}...`)
    await runDatabaseMigrations(selected_deployment, !selected_deployment.backup); 
    console.log(`Rebuilding views on ${selected_deployment.title}...`)
    await rebuildViews(selected_deployment);
    console.log(`\n\nDone!`)
}

// npm run rebuildViews (deployment)
//   Rebuilds all views in the database
//
//   params:
//   deployment (optional) - name of deployment in deployments.json, defaults to first deployment in deployments.json
async function triggerRebuildViews() {
    const deployments_info = JSON.parse(fs.readFileSync(path.join(__dirname, 'deployments.json'), 'utf8'));
    let selected_deployment = deployments_info[Object.keys(deployments_info)[0]];

    // if deployment is not specified, set selected deployment to first deployment in deployments.json
    if (process.argv[process.argv.indexOf('rebuildViews') + 1] !== undefined) {
        const deployment = process.argv[process.argv.indexOf('rebuildViews') + 1];
        const deployment_info = deployments_info[deployment];
        
        if (deployment_info) {
            selected_deployment = deployment_info;
        } else {
            console.error(`Deployment ${deployment} not found in deployments.json`);
            return;
        }
    }

    console.log(`Rebuilding views on ${selected_deployment.title}...`)
    await rebuildViews(selected_deployment);
}

// npm run anonymise (deployment)
//   Anonymises the database
//
//   params:
//   deployment (optional) - name of deployment in deployments.json, defaults to first deployment in deployments.json
async function triggerAnonymise() {
    const deployments_info = JSON.parse(fs.readFileSync(path.join(__dirname, 'deployments.json'), 'utf8'));
    let selected_deployment = deployments_info[Object.keys(deployments_info)[0]];

    // if deployment is not specified, set selected deployment to first deployment in deployments.json
    if (process.argv[process.argv.indexOf('anonymise') + 1] !== undefined) {
        const deployment = process.argv[process.argv.indexOf('anonymise') + 1];
        const deployment_info = deployments_info[deployment];
        
        if (deployment_info) {
            selected_deployment = deployment_info;
        } else {
            console.error(`Deployment ${deployment} not found in deployments.json`);
            return;
        }
    }

    console.log(`Anonymising ${selected_deployment.title}...`)
    await anonymiseDatabase(selected_deployment);
}

// npm run syncDatabases (deployment)
//   Syncronises the production database to the development database
//   uses env.SYNC_FROM_DEPLOYMENT and env.SYNC_TO_DEPLOYMENT to determine which deployments to sync
async function triggerSyncDatabases() {
    const deployments_info = JSON.parse(fs.readFileSync(path.join(__dirname, 'deployments.json'), 'utf8'));
    const fromDeployment = deployments_info[process.env.SYNC_FROM_DEPLOYMENT];
    const toDeployment = deployments_info[process.env.SYNC_TO_DEPLOYMENT];
    console.log(`Syncronising deployments...`)
    await runSyncDatabases(fromDeployment, toDeployment);
}

// npm run rebuildUsers (deployment)
//   Rebuilds all users for a database
//
//   params:
//   deployment (optional) - name of deployment in deployments.json, defaults to first deployment in deployments.json
async function triggerRebuildUsers() {
    const deployments_info = JSON.parse(fs.readFileSync(path.join(__dirname, 'deployments.json'), 'utf8'));
    let selected_deployment = deployments_info[Object.keys(deployments_info)[0]];

    // if deployment is not specified, set selected deployment to first deployment in deployments.json
    if (process.argv[process.argv.indexOf('rebuildUsers') + 1] !== undefined) {
        const deployment = process.argv[process.argv.indexOf('rebuildUsers') + 1];
        const deployment_info = deployments_info[deployment];
        
        if (deployment_info) {
            selected_deployment = deployment_info;
        } else {
            console.error(`Deployment ${deployment} not found in deployments.json`);
            return;
        }
    }

    console.log(`Recreating Users for ${selected_deployment.title}...`)
    await rebuildUsers(selected_deployment);
}

// npm run rebuildForeignKeys (deployment)
//   Rebuilds all foriegn keys in the database
//
//   params:
//   deployment (optional) - name of deployment in deployments.json, defaults to first deployment in deployments.json
async function triggerRebuildForeignKeys() {
    const deployments_info = JSON.parse(fs.readFileSync(path.join(__dirname, 'deployments.json'), 'utf8'));
    let selected_deployment = deployments_info[Object.keys(deployments_info)[0]];

    // if deployment is not specified, set selected deployment to first deployment in deployments.json
    if (process.argv[process.argv.indexOf('rebuildForeignKeys') + 1] !== undefined) {
        const deployment = process.argv[process.argv.indexOf('rebuildForeignKeys') + 1];
        const deployment_info = deployments_info[deployment];
        
        if (deployment_info) {
            selected_deployment = deployment_info;
        } else {
            console.error(`Deployment ${deployment} not found in deployments.json`);
            return;
        }
    }

    console.log(`Recreating foreign keys for ${selected_deployment.title}...`)
    await rebuildForeignKeys(selected_deployment);
}

// npm run build (deployment)
// npm run watch (deployment)
// npm run publish (deployment)
//   Triggers npm install, npm prune, then npm run build/watch/publish
//
//   params:
//   deployment (optional) - name of deployment in deployments.json, defaults to first deployment in deployments.json
async function triggerNPM() {
    let selected_cmd = 'build';
    if (process.argv.includes('watch')) { selected_cmd = 'watch'; }
    if (process.argv.includes('publish')) { selected_cmd = 'publish'; }

    const deployments_info = JSON.parse(fs.readFileSync(path.join(__dirname, 'deployments.json'), 'utf8'));
    let selected_deployment = deployments_info[Object.keys(deployments_info)[0]];

    // if deployment is not specified, set selected deployment to first deployment in deployments.json
    if (process.argv[process.argv.indexOf(selected_cmd) + 1] !== undefined) {
        const deployment = process.argv[process.argv.indexOf(selected_cmd) + 1];
        const deployment_info = deployments_info[deployment];
        
        if (deployment_info) {
            selected_deployment = deployment_info;
        } else {
            console.error(`Deployment ${deployment} not found in deployments.json`);
            return;
        }
    }

    console.log(`Installing NPM dependancies and running ${selected_cmd} script for ${selected_deployment.title}...`)
    await rebuildNPM(selected_deployment, selected_cmd);
}

module.exports = {
    migrate: triggerMigrate,
    rebuildViews: triggerRebuildViews,
    anonymise: triggerAnonymise,
    syncDatabases: triggerSyncDatabases,
    rebuildUsers: triggerRebuildUsers,
    rebuildForeignKeys: triggerRebuildForeignKeys,
    build: triggerNPM,
    watch: triggerNPM,
    publish: triggerNPM,
};

require('make-runnable/custom')({
    printOutputFrame: false
})