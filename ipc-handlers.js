let initialized = false

module.exports = (handlers, dbManager) => {
    if (initialized) return
    initialized = true
  
    const { ipcMain } = require('electron')

    ipcMain.handle('get-today-count', async () => {
        return dbManager.getTodayCount()
    })

    ipcMain.on('minimize', () => handlers.mainWindow.minimize())
    ipcMain.on('close', () => handlers.mainWindow.close())
    ipcMain.on('start-timer', handlers.startTimer)
    ipcMain.on('stop-timer', handlers.stopTimer)
    ipcMain.on('start-break', handlers.startBreak)
}