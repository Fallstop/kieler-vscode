// Shared by the server suites: where the language server JAR is and which Java runs it.
//
//   SCCHARTS_SERVER_DIR  directory holding sccharts-lite-server.jar (default: ../server)
//   SCCHARTS_JAVA        java launcher for the server process (default: java from PATH).
//                        Point it at server/jre/bin/java to test the bundled runtime image.
const path = require('node:path')

const serverDir = process.env.SCCHARTS_SERVER_DIR ?? path.resolve(__dirname, '../server')
const classpath = path.join(serverDir, 'sccharts-lite-server.jar')
const java = process.env.SCCHARTS_JAVA ?? 'java'
const serverArgs = ['-Djava.awt.headless=true', '-cp', classpath, 'de.cau.cs.kieler.language.server.LanguageServer']

module.exports = { serverDir, classpath, java, serverArgs }
