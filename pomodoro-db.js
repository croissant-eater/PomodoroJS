const { app } = require('electron')
const sqlite3 = require('sqlite3').verbose()
const path = require('path')
const { promisify } = require('util')
const fs = require('fs')
const ExcelJS = require('exceljs')

class DatabaseManager {
    constructor() {
        if (DatabaseManager.instance) return DatabaseManager.instance
        DatabaseManager.instance = this
    
        this.sessionDir = path.join(__dirname, 'PomoSessions')
        this.excelPath = path.join(this.sessionDir, 'pomodoro-history.xlsx')
        this.txtPath = path.join(this.sessionDir, 'daily-sessions.txt')
        this.ensureSessionDir()
    
        this.db = null
        this.initialized = false
    }

    ensureSessionDir() {
        if (!fs.existsSync(this.sessionDir)) {
            fs.mkdirSync(this.sessionDir, { recursive: true })
        }
    }

    async initialize() {
        if (this.initialized) return
        this.initialized = true
    
        await app.whenReady()
        this.db = new sqlite3.Database(path.join(app.getPath('userData'), 'pomodoro.db'))
        this.db.run = promisify(this.db.run)
        this.db.get = promisify(this.db.get)
            
        await this.runMigration()
    }

    async runMigration() {
        await this.db.run(`CREATE TABLE IF NOT EXISTS daily_sessions (
            date TEXT PRIMARY KEY,
            count INTEGER DEFAULT 0
        )`)
    }

    getLocalDateString() {
        const now = new Date();
        return now.toLocaleDateString('en-CA', { // YYYY-MM-DD format
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
        });
    }

    async incrementDailySession() {
        const today = this.getLocalDateString();
    
        await this.db.run(
            `INSERT INTO daily_sessions (date, count) 
            VALUES (?, 1)
            ON CONFLICT(date) DO UPDATE SET count = count + 1`,
            [today]
        )

        const currentCount = await this.getTodayCount()
        
        // Update both TXT files
        fs.writeFileSync(this.txtPath, `${today}: ${currentCount}`);
        fs.writeFileSync(path.join(this.sessionDir, `pomo_${today}.txt`), currentCount.toString());

        // Update Excel
        await this.updateExcel(today, currentCount)
    }

    async updateExcel(dateString, count) {
        const workbook = new ExcelJS.Workbook();
        let worksheet;
    
        // Load or create workbook
        if (fs.existsSync(this.excelPath)) {
            await workbook.xlsx.readFile(this.excelPath);
            worksheet = workbook.getWorksheet('Sessions');
        } else {
            worksheet = workbook.addWorksheet('Sessions');
            worksheet.columns = [
                { 
                    header: 'Date', 
                    key: 'date', 
                    width: 15,
                    style: { numFmt: '@' } // Force text format
                },
                { header: 'Sessions', key: 'count', width: 10 }
            ];
        }
    
        // Format date as DD-MM-YYYY string
        const [year, month, day] = dateString.split('-');
        const formattedDate = `${day}-${month}-${year}`;
    
        // Find existing row
        let targetRow = null;
        worksheet.eachRow((row, rowNumber) => {
            if (rowNumber > 1 && row.getCell(1).text === formattedDate) {
                targetRow = row;
            }
        });
    
        // Update or create row
        if (targetRow) {
            targetRow.getCell(2).value = count;
        } else {
            worksheet.addRow([formattedDate, count]);
        }
    
        // Maintain date
        const rows = [];
        worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
            if (rowNumber > 1) rows.push(row);
        });
    
        rows.sort((a, b) => {
            const dateA = a.getCell(1).text.split('-').reverse().join('-');
            const dateB = b.getCell(1).text.split('-').reverse().join('-');
            return new Date(dateA) - new Date(dateB);
        });
    
        // Clear and re-add sorted rows
        worksheet.spliceRows(2, worksheet.rowCount, ...rows.map(row => row.values));
    
        // Save changes
        await workbook.xlsx.writeFile(this.excelPath);
    }

    async getTodayCount() {
        const today = this.getLocalDateString();
        const row = await this.db.get(
            'SELECT count FROM daily_sessions WHERE date = ?',
            [today]
        )
        return row ? row.count : 0
    }
}

module.exports = DatabaseManager