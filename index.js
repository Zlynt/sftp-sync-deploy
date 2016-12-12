require('colors');
const Client = require('ssh2').Client;
const minimatch = require('minimatch');
const path = require('path');
const fs = require('fs');
const util = require('./util');

/**
 * Creates a new SftpDeploy instance
 * @class
 */
function SftpDeploy(config, options) {
  /**
   * Config object
   * @member {Object}
   * @property {string} host
   * @property {number} port
   * @property {string} username
   * @property {string} password
   * @property {string} passphrase
   * @property {string} privateKey
   * @property {string} localDir
   * @property {string} remoteDir
   */
  this.config = config;

  /**
   * Options object
   * @member {Object}
   * @property {boolean} dryRun
   */
  this.options = Object.assign({
    dryRun: false,
    exclude: []
  }, options);

  /**
   * SSH2 Client
   * @member {ssh2.Client}
   */
  this.client = new Client;

  /**
   * SFTP stream
   * @member {ssh2.SFTPWrapper}
   */
  this.sftp = undefined;

  let localDir = util.chomp(path.resolve(this.config.localDir), path.sep);
  let remoteDir = util.chomp(this.config.remoteDir, '/');

  if (!fs.statSync(localDir).isDirectory()) {
    throw new Error('src: ' + localDir + ' is not directory');
  }

  /**
   * Local directory root
   * @member {string}
   */
  this.localDir = localDir;

  /**
   * Remote directory root
   * @member {string}
   */
  this.remoteDir = remoteDir;
}

/**
 * Make SSH2 connection and start sync
 * @return {Promise.<boolean>}
 */
SftpDeploy.prototype.start = function() {
  return new Promise((resolve, reject) => {
    this.client.on('ready', () => {
      this.sync(this.localDir, this.remoteDir).then(() => {
        resolve(true);
      }).catch(err => {
        reject(err);
      }).then(() => {
        this.client.end();
      });
    })
    .on('error', err => {
      reject(err);
    })
    .connect({
      host: this.config.host,
      port: this.config.port || 22,
      username: this.config.username,
      password: this.config.password,
      passphrase: this.config.passphrase,
      privateKey: this.config.privateKey ? fs.readFileSync(this.config.privateKey) : undefined
    });
  });
};

/**
 * Get sftp stream
 * @return {Promise.<ssh2.SFTPWrapper>}
 */
SftpDeploy.prototype.getSftp = function() {
  if (this.sftp) {
    return Promise.resolve(this.sftp);
  }

  return new Promise((resolve, reject) => {
    this.client.sftp((err, sftp) => {
      if (err) return reject(err);

      this.sftp = sftp;
      resolve(sftp);
    });
  });
};

/**
 * Sync with specified path
 * @param {string} localPath
 * @param {string} remotePath
 * @return {Promise.<boolean>}
 */
SftpDeploy.prototype.sync = function(localPath, remotePath) {
  return this.buildProject(localPath, remotePath).then(project => {
    let operations = [];

    project.forEach((stats, filename) => {
      let localFilePath = localPath + path.sep + filename;
      let remoteFilePath = remotePath + '/' + filename;
      let task = util.getTask(stats);
      let args = [localFilePath, remoteFilePath];

      if (this.options.dryRun) {
        let taskName = '';

        if (task.removeRemote) {
          taskName = 'remove remote';
          if (task.method !== 'noop') {
            taskName += ' and ' + task.method;
          }
        } else if (task.method === 'noop') {
          taskName = 'ignored';
        } else {
          taskName = task.method;
        }

        console.log(`[ ${util.label(stats.local)} | ${util.label(stats.remote)} ] ` + util.normalizedRelativePath(localFilePath, this.localDir));
        console.log(`          -> ${taskName}`.magenta);
        console.log('');

        if (task.method === 'sync' || stats.local === 'dir') {
          operations.push(this.sync(localFilePath, remoteFilePath));
        }
        return;
      }

      let preMethod = task.removeRemote ? this.removeRemote(remoteFilePath) : Promise.resolve();

      operations.push(preMethod.then(() => this[task.method].apply(this, args)));
    });

    return Promise.all(operations);
  }).then(() => {
    if (!this.options.dryRun) {
      console.log('     sync completed : '.cyan + util.normalizedRelativePath(localPath, this.localDir));
    }

    return true;
  });
};

/**
 * Upload the file
 * @param {string} localPath
 * @param {string} remotePath
 * @return {Promise.<void>}
 */
SftpDeploy.prototype.upload = function(localPath, remotePath) {
  let isDirectory = fs.statSync(localPath).isDirectory();

  return new Promise((resolve, reject) => {
    this.getSftp().then(sftp => {
      if (isDirectory) {
        let localList = fs.readdirSync(localPath);

        sftp.mkdir(remotePath, err => {
          if (err) return reject(err);

          let children = [];

          localList.forEach(filename => {
            let fullPath = localPath + path.sep + filename;
            let isDir = fs.statSync(fullPath).isDirectory();
            let ignored = this.isIgnored(fullPath, isDir);

            if (!ignored) {
              children.push(this.upload(localPath + path.sep + filename, remotePath + '/' + filename));
            }
          });

          Promise.all(children).then(() => {
            console.log(' directory uploaded : '.yellow + util.normalizedRelativePath(localPath, this.localDir));
            resolve();
          });
        });
      } else {
        sftp.fastPut(localPath, remotePath, (err) => {
          if (err) return reject(err);

          console.log('      file uploaded : '.yellow + util.normalizedRelativePath(localPath, this.localDir));
          resolve();
        });
      }
    });
  });
};

/**
 * Remove the specified remote file or directory
 * @param {string} remotePath
 * @return {Promise.<void>}
 */
SftpDeploy.prototype.removeRemote = function(remotePath) {
  return new Promise((resolve, reject) => {
    this.getSftp().then(sftp => {
      sftp.stat(remotePath, (err, stat) => {
        if (err) return reject(err);

        if (stat.isDirectory()) {
          sftp.readdir(remotePath, (err, list) => {
            if (err) return reject(err);

            let children = [];

            list.forEach(file => {
              children.push(this.removeRemote(remotePath + '/' + file.filename));
            });

            Promise.all(children).then(() => {
              sftp.rmdir(remotePath, err => {
                if (err) return reject(err);

                console.log(' remote dir removed : '.red + util.normalizedRelativePath(remotePath, this.remoteDir));
                resolve();
              });
            });
          });
        } else {
          sftp.unlink(remotePath, err => {
            if (err) return reject(err);

            console.log('remote file removed : '.red + util.normalizedRelativePath(remotePath, this.remoteDir));
            resolve();
          });
        }
      });
    });
  });
};

/**
 * dummy operation
 * @return {Promise}
 */
SftpDeploy.prototype.noop = function() {
  return Promise.resolve();
};

/**
 * Build a local and remote files status report for specified path
 * @param {string} localPath
 * @param {string} remotePath
 * @return {Promise.<Map>}
 */
SftpDeploy.prototype.buildProject = function(localPath, remotePath) {
  let localList = fs.readdirSync(localPath);
  let project = new Map();

  localList.forEach(filename => {
    let fullPath = localPath + path.sep + filename;
    let isDir = fs.statSync(fullPath).isDirectory();
    let ignored = this.isIgnored(fullPath, isDir);

    project.set(filename, {local: ignored ? 'ignored' : isDir ? 'dir' : 'file', remote: null});
  });

  return new Promise((resolve, reject) => {
    this.getSftp().then(sftp => {
      sftp.readdir(remotePath, (err, remoteList) => {
        let operations = [];

        if (err) {
          if (err.code === 2) { // No such file
            resolve(project);
          } else {
            reject(err);
          }
          return;
        }

        remoteList.forEach(file => {
          let setStat = new Promise((resolve2, reject2) => {
            sftp.stat(remotePath + '/' + file.filename, (err, stat) => {
              if (err) return reject2(err);

              let type = stat.isDirectory() ? 'dir' : 'file';
              let stats;

              if (project.has(file.filename)) {
                stats = project.get(file.filename);
                stats.remote = type;
              } else {
                stats = {local: null, remote: type};
              }

              project.set(file.filename, stats);

              resolve2();
            });
          });

          operations.push(setStat);
        });

        Promise.all(operations)
        .then(() => resolve(project))
        .catch(err => reject(err));
      });
    });
  });
};

/**
 * Check if the path matches the exclude patterns
 * @param {string} localPath
 * @param {boolean} isDir
 * @return {boolean}
 */
SftpDeploy.prototype.isIgnored = function(localPath, isDir) {
  let pathForMatch = util.normalizedRelativePath(localPath, this.localDir);

  if (isDir) pathForMatch += '/';

  return this.options.exclude.some(pattern => minimatch(pathForMatch, pattern));
}

/**
 * @return {Promise.<boolean>}
 */
function deploy(config, options) {
  const deployer = new SftpDeploy(config, options);

  console.log(`* Deploying to host ${config.host}`.green);
  console.log('* local dir  = '.gray + deployer.localDir);
  console.log('* remote dir = '.gray + deployer.remoteDir);
  console.log('');

  return deployer.start();
};

deploy.deploy = deploy.default = deploy;
module.exports = deploy;
