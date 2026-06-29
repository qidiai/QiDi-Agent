const chalk = require('chalk');
const packageJson = require('../../package.json');

const version = packageJson.version;

const logo = `
${chalk.yellow(' QQQQQ   III   DDDDD   III')}
${chalk.yellow(' QQ  QQ   II   DD  DD   II')}
${chalk.yellow(' QQ  QQ   II   DD  DD   II')}
${chalk.yellow(' QQ  QQ   II   DDDDD    II')}
${chalk.yellow(' QQQQQ    II   DD       II')}
${chalk.yellow('    QQ                        QQ')}
${chalk.cyan('   ────────────────────────────────')}
${chalk.bold.yellow(`         QIDI AGENT v${version}`)}
${chalk.gray('     Multi-AI Tool Orchestration')}
${chalk.cyan('   ────────────────────────────────')}
`;

const miniLogo = `
${chalk.yellow(' QQQQQ   III   DDDDD   III')}
${chalk.yellow(' QQ  QQ   II   DD  DD   II')}
${chalk.yellow(' QQ  QQ   II   DD  DD   II')}
${chalk.yellow(' QQ  QQ   II   DDDDD    II')}
${chalk.yellow(' QQQQQ    II   DD       II')}
${chalk.yellow('    QQ                        QQ')}
${chalk.bold.yellow('  QIDI AGENT')}
`;

const banner = `
${chalk.cyan('═══════════════════════════════════════════')}
${chalk.bold.yellow(' QQQQQ   III   DDDDD   III')}
${chalk.bold.yellow(' QQ  QQ   II   DD  DD   II')}
${chalk.bold.yellow(' QQ  QQ   II   DD  DD   II')}
${chalk.bold.yellow(' QQ  QQ   II   DDDDD    II')}
${chalk.bold.yellow(' QQQQQ    II   DD       II')}
${chalk.bold.yellow('    QQ                        QQ')}
${chalk.cyan('═══════════════════════════════════════════')}
`;

function printLogo (options = {}) {
  if (options.mini) {
    console.log(miniLogo);
  } else if (options.banner) {
    console.log(banner);
  } else {
    console.log(logo);
  }
}

module.exports = {
  logo,
  miniLogo,
  banner,
  printLogo
};
