module.exports = {
    apps : [
      {
        name: "rcja-deployer",
        script: "index.js",
        env: {
            NODE_ENV: "production",
        },
        log_date_format: "YYYY-MM-DD HH:mm"
      },
    ],
};