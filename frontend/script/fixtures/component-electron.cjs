'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const userData = process.env.REVERIE_COMPONENT_DATA;
if (!userData || !path.isAbsolute(userData)) throw Error('isolated data required');
app.setPath('userData', userData);
app.setPath('sessionData', userData);
app.setPath('logs', path.join(userData, 'logs'));
app.setPath('crashDumps', path.join(userData, 'crashes'));
const deadline = setTimeout(() => { process.exitCode = 1; app.quit(); }, 40000);
process.stdin.once('data', async () => {
  try {
    await app.whenReady();
    const window = new BrowserWindow({ show: false, width: 1200, height: 800, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await window.loadURL(process.env.REVERIE_COMPONENT_URL);
    const deadline = Date.now() + 15000;
    while (!await window.webContents.executeJavaScript('typeof window.runComponentChecks === "function"')) {
      if (Date.now() > deadline) throw Error('component fixture did not load');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const result = await window.webContents.executeJavaScript('window.runComponentChecks()');
    process.stdout.write(`COMPONENT_RESULT ${JSON.stringify(result)}\n`);
    process.exitCode = result.passed ? 0 : 1;
  } catch (error) { process.stdout.write(`COMPONENT_RESULT ${JSON.stringify({ passed: false, error: String(error) })}\n`); process.exitCode = 1; }
  finally { clearTimeout(deadline); app.quit(); }
});
