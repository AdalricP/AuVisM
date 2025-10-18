const { app, BrowserWindow, Tray, Menu, ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");

// Helper: get persistent data.json path
function getUserDataPath() {
  return path.join(app.getPath('userData'), 'data.json');
}

// Helper: copy default data.json to userData if missing
function ensureUserDataJson() {
  const userDataPath = getUserDataPath();
  if (!fs.existsSync(userDataPath)) {
    const defaultPath = path.join(__dirname, 'Files', 'data.json');
    if (fs.existsSync(defaultPath)) {
      fs.copyFileSync(defaultPath, userDataPath);
    } else {
      fs.writeFileSync(userDataPath, '{}');
    }
  }
}

// Optional auto-launch (don't crash if missing)
let AutoLaunch;
try {
  AutoLaunch = require("auto-launch");
} catch (e) {
  console.warn("auto-launch not available, skipping:", e && e.message);
}

if (AutoLaunch) {
  try {
    const myAppAutoLauncher = new AutoLaunch({
      name: "AuVisM",
      path: app.getPath("exe"),
    });
    myAppAutoLauncher
      .isEnabled()
      .then((isEnabled) => {
        if (!isEnabled) myAppAutoLauncher.enable();
      })
      .catch((err) => {
        console.error("Auto-launch failed:", err);
      });
  } catch (e) {
    console.warn("Failed to set up auto-launch:", e);
  }
}

let mainWindow;
let colorPickerWindow = null;
let tray = null;
// Window will stay at the display workArea size always.

function ensureTray() {
  if (!tray) {
    tray = new Tray(path.join(__dirname, "Files/sound-wave.png"));
  }
  return tray;
}

function saveData(data) {
  const filePath = getUserDataPath();
  fs.writeFileSync(filePath, JSON.stringify(data));
}

function savePartial(patch) {
  try {
    const filePath = getUserDataPath();
    let data = {};
    if (fs.existsSync(filePath)) {
      data = JSON.parse(fs.readFileSync(filePath));
    }
    const merged = { ...data, ...patch };
    fs.writeFileSync(filePath, JSON.stringify(merged));
  } catch (e) {
    console.error('Failed to save partial settings:', e);
  }
}

function loadData() {
  const filePath = getUserDataPath();
  if (fs.existsSync(filePath)) {
    const data = JSON.parse(fs.readFileSync(filePath));
    return data;
  }
  return null;
}

function getSafeWindowBounds(bounds) {
  try {
    const { screen } = require('electron');
    const displays = screen.getAllDisplays();
    if (!displays || displays.length === 0) return bounds;
    const primary = screen.getPrimaryDisplay();
    const target = bounds && Number.isFinite(bounds.x) && Number.isFinite(bounds.y)
      ? screen.getDisplayNearestPoint({ x: Math.round(bounds.x + (bounds.width || 0) / 2), y: Math.round(bounds.y + (bounds.height || 0) / 2) })
      : primary;
    const wa = (target && target.workArea) || primary.workArea;
    const minW = 400; const minH = 200;
    const maxW = Math.max(minW, wa.width);
    const maxH = Math.max(minH, wa.height);
    const width = Math.max(minW, Math.min(bounds.width || 1200, maxW));
    const height = Math.max(minH, Math.min(bounds.height || 800, maxH));
    const x = Math.min(Math.max(wa.x, bounds.x || wa.x), wa.x + wa.width - width);
    const y = Math.min(Math.max(wa.y, bounds.y || wa.y), wa.y + wa.height - height);
    return { x, y, width, height };
  } catch (e) {
    console.error('Failed computing safe window bounds:', e);
    return bounds;
  }
}

function createWindow() {
  const data = loadData();
  // Use default size if no saved data or if saved size is too small
  const defaultConfig = { width: 1200, height: 800, x: 100, y: 100 };
  const preferred = data && data.windowBounds && data.windowBounds.width > 100 ? data.windowBounds : defaultConfig;
  const windowConfig = getSafeWindowBounds(preferred);

  mainWindow = new BrowserWindow({
    ...windowConfig,
    frame: false,
    transparent: true,
    // Start not on top; user can enable from tray
    alwaysOnTop: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: true,
      contextIsolation: true,
      webSecurity: false,
      backgroundThrottling: false
    },
    backgroundColor: '#00000000'
  });

  mainWindow.setIgnoreMouseEvents(true, { forward: true });
  mainWindow.blur();
  mainWindow.loadFile("index.html");
  mainWindow.setFullScreenable(false);
  // Default: do NOT force visibility across all workspaces to avoid overlaying everywhere
  mainWindow.setVisibleOnAllWorkspaces(false);
  mainWindow.setResizable(true);
  mainWindow.setMaximizable(true);
  mainWindow.setMinimizable(false);

  // Respect restored bounds; no forced full workArea sizing

  // Save window bounds on move/resize with a small debounce
  let saveBoundsTimer = null;
  const scheduleSaveBounds = () => {
    if (saveBoundsTimer) clearTimeout(saveBoundsTimer);
    saveBoundsTimer = setTimeout(() => {
      try {
        const b = mainWindow.getBounds();
        const safe = getSafeWindowBounds(b);
        savePartial({ windowBounds: safe });
      } catch (e) {
        console.error('Failed to save window bounds:', e);
      }
    }, 250);
  };
  mainWindow.on('move', scheduleSaveBounds);
  mainWindow.on('resize', scheduleSaveBounds);

  mainWindow.on("close", () => {
    const windowBounds = mainWindow.getBounds();
    // Request all settings from renderer (color, noise, resolution, etc. + visualizer position/size/rotation)
    mainWindow.webContents.send("Settings-Data-Request");
    // Only listen once per close
    ipcMain.once("Settings-Data-Transfer", (event, partial_data) => {
      // partial_data: [color, noiseIntensity, resolution, visualMode, smoothInterpolation, smoothTransitions, minBarHeight, vizPosSizeRot, processing]
      const vizPosSizeRot = partial_data[7] || {};
      const processing = partial_data[8] || {};
      const data = {
        windowBounds: windowBounds,
        color: partial_data[0],
        noiseIntensity: partial_data[1],
        resolution: partial_data[2],
        visualMode: partial_data[3] || 'linear',
        smoothInterpolation: partial_data[4] || false,
        smoothTransitions: partial_data[5] || false,
        minBarHeight: partial_data[6] || 0,
        vizPosSizeRot: vizPosSizeRot,
        processing: processing
      };
      saveData(data);
      mainWindow = null;
    });
  });

  // Ensure only one tray instance exists
  ensureTray();
  var contextMenu = Menu.buildFromTemplate([
    {
      label: "Edit Mode",
      type: "checkbox",
      click: () => {
        mainWindow.setIgnoreMouseEvents(!contextMenu.items[0].checked, {
          forward: true,
        });
        mainWindow.webContents.send("drag-state", contextMenu.items[0].checked);
        mainWindow.setResizable(contextMenu.items[0].checked);
        // Do not change window bounds on toggle; window remains full workArea
      },
    },
    {
      label: "Always on Top",
      type: "checkbox",
      checked: false,
      click: (menuItem) => {
        const on = !!menuItem.checked;
        if (on) {
          // Use a high level so overlay stays above apps when enabled
          mainWindow.setAlwaysOnTop(true, 'screen-saver');
          mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        } else {
          // Return to normal stacking and not across all spaces
          mainWindow.setAlwaysOnTop(false);
          mainWindow.setVisibleOnAllWorkspaces(false);
        }
      },
    },
    {
      label: "Settings",
      submenu: [
        {
          label: "Appearance",
          submenu: [
            {
              label: "Colour",
              click: () => {
                if (colorPickerWindow == null) createColorPickerWindow();
              },
            },
            {
              label: "Maximize",
              click: () => {
                const { screen } = require('electron');
                const primaryDisplay = screen.getPrimaryDisplay();
                const { x, y, width, height } = primaryDisplay.workArea;
                mainWindow.setBounds({ x, y, width, height });
              },
            },
          ],
        },
        {
          label: "Visualizer Settings",
          submenu: [
            {
              label: "Fill Smooth Line",
              type: "checkbox",
              checked: false,
              click: (menuItem) => {
                mainWindow.webContents.send("fill-smooth-line-toggle", menuItem.checked);
              },
            },
            {
              label: "Noise Intensity",
              submenu: [
                {
                  label: "None",
                  type: "radio",
                  checked: true,
                  click: () => {
                    mainWindow.webContents.send("noise-change", 0);
                  },
                },
                {
                  label: "Soft",
                  type: "radio",
                  click: () => {
                    mainWindow.webContents.send("noise-change", 12);
                  },
                },
                {
                  label: "Medium",
                  type: "radio",
                  click: () => {
                    mainWindow.webContents.send("noise-change", 32);
                  },
                },
                {
                  label: "Strong",
                  type: "radio",
                  click: () => {
                    mainWindow.webContents.send("noise-change", 60);
                  },
                },
              ],
            },
            {
              label: "Minimum Bar Height",
              submenu: [
                {
                  label: "None (0%)",
                  type: "radio",
                  checked: true,
                  click: () => {
                    mainWindow.webContents.send("min-bar-height-change", 0);
                  },
                },
                {
                  label: "Small (2%)",
                  type: "radio",
                  click: () => {
                    mainWindow.webContents.send("min-bar-height-change", 2);
                  },
                },
                {
                  label: "Medium (5%)",
                  type: "radio",
                  click: () => {
                    mainWindow.webContents.send("min-bar-height-change", 5);
                  },
                },
              ],
            },
            {
              label: "Waveform Thickness",
              submenu: [
                {
                  label: "Thin",
                  type: "radio",
                  click: () => {
                    mainWindow.webContents.send("waveform-thickness-change", 1.0);
                  },
                },
                {
                  label: "Normal",
                  type: "radio",
                  checked: true,
                  click: () => {
                    mainWindow.webContents.send("waveform-thickness-change", 1.5);
                  },
                },
                {
                  label: "Thick",
                  type: "radio",
                  click: () => {
                    mainWindow.webContents.send("waveform-thickness-change", 2.5);
                  },
                },
                {
                  label: "Extra Thick",
                  type: "radio",
                  click: () => {
                    mainWindow.webContents.send("waveform-thickness-change", 4.0);
                  },
                },
              ],
            },
            {
              label: "Resolution / Bar Count",
              submenu: [
                {
                  label: "crash",
                  type: "radio",
                  click: () => {
                    mainWindow.webContents.send("resolution-change", 4096);
                  },
                },
                {
                  label: "2048",
                  type: "radio",
                  click: () => {
                    mainWindow.webContents.send("resolution-change", 2048);
                  },
                },
                {
                  label: "1024",
                  type: "radio",
                  click: () => {
                    mainWindow.webContents.send("resolution-change", 1024);
                  },
                },
                {
                  label: "512",
                  type: "radio",
                  click: () => {
                    mainWindow.webContents.send("resolution-change", 512);
                  },
                },
                {
                  label: "256",
                  type: "radio",
                  click: () => {
                    mainWindow.webContents.send("resolution-change", 256);
                  },
                },
                {
                  label: "128",
                  type: "radio",
                  click: () => {
                    mainWindow.webContents.send("resolution-change", 128);
                  },
                },
                {
                  label: "64",
                  type: "radio",
                  click: () => {
                    mainWindow.webContents.send("resolution-change", 64);
                  },
                },
              ],
            },
            {
              label: 'Processing',
              submenu: [
                { label: 'Energy Mode (power)', type: 'checkbox', checked: true, click: (mi)=> mainWindow.webContents.send('viz-toggle-energy', mi.checked) },
                { label: 'Bandwidth Compensation', type: 'checkbox', checked: true, click: (mi)=> mainWindow.webContents.send('viz-toggle-bandwidth-comp', mi.checked) },
                { label: 'Log Frequency Scale', type: 'checkbox', checked: true, click: (mi)=> mainWindow.webContents.send('viz-toggle-log-scale', mi.checked) },
                { label: 'dB Scaling', type: 'checkbox', checked: true, click: (mi)=> mainWindow.webContents.send('viz-toggle-db-scale', mi.checked) },
                { type: 'separator' },
                { label: 'Tilt +2 dB/oct', type: 'radio', click: ()=> mainWindow.webContents.send('viz-tilt-db-per-oct', 2) },
                { label: 'Tilt +4 dB/oct', type: 'radio', checked: true, click: ()=> mainWindow.webContents.send('viz-tilt-db-per-oct', 4) },
                { label: 'Tilt +6 dB/oct', type: 'radio', click: ()=> mainWindow.webContents.send('viz-tilt-db-per-oct', 6) },
                { label: 'Tilt Off', type: 'radio', click: ()=> mainWindow.webContents.send('viz-tilt-db-per-oct', 0) },
                { type: 'separator' },
                { label: 'Min Freq 20 Hz', type: 'radio', checked: true, click: ()=> mainWindow.webContents.send('viz-min-frequency', 20) },
                { label: 'Min Freq 40 Hz', type: 'radio', click: ()=> mainWindow.webContents.send('viz-min-frequency', 40) },
                { label: 'Min Freq 60 Hz', type: 'radio', click: ()=> mainWindow.webContents.send('viz-min-frequency', 60) },
                { type: 'separator' },
                { label: 'dB Floor -80', type: 'radio', click: ()=> mainWindow.webContents.send('viz-db-floor', -80) },
                { label: 'dB Floor -70', type: 'radio', checked: true, click: ()=> mainWindow.webContents.send('viz-db-floor', -70) },
                { label: 'dB Floor -60', type: 'radio', click: ()=> mainWindow.webContents.send('viz-db-floor', -60) },
              ]
            },
            {
              label: "Visualization Mode",
              submenu: [
                {
                  label: "Linear",
                  type: "radio",
                  click: () => {
                    mainWindow.webContents.send("visual-mode-change", "linear");
                  },
                },
                {
                  label: "Linear (Smooth)",
                  type: "radio",
                  click: () => {
                    mainWindow.webContents.send("visual-mode-change", "linear-smooth");
                  },
                },
                {
                  label: "Linear Waveform",
                  type: "radio",
                  click: () => {
                    mainWindow.webContents.send("visual-mode-change", "linear-waveform");
                  },
                },
                {
                  label: "Circle Perimeter",
                  type: "radio",
                  click: () => {
                    mainWindow.webContents.send("visual-mode-change", "circle-perimeter");
                  },
                },
                {
                  label: "Circle Waveform",
                  type: "radio",
                  click: () => {
                    mainWindow.webContents.send("visual-mode-change", "circle-waveform");
                  },
                },
              ],
            },
            {
              label: "Smooth Interpolation",
              type: "checkbox",
              click: (menuItem) => {
                mainWindow.webContents.send("smooth-interpolation-toggle", menuItem.checked);
              },
            },
            {
              label: "Smooth Transitions",
              type: "checkbox",
              click: (menuItem) => {
                mainWindow.webContents.send("smooth-transitions-toggle", menuItem.checked);
              },
            },
          ],
        },
      ],
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
}

function createColorPickerWindow() {
  colorPickerWindow = new BrowserWindow({
    width: 400,
    height: 400,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      enableRemoteModule: false,
    },
  });
  colorPickerWindow.loadFile("colorpicker/color.html");

  colorPickerWindow.setResizable(false);
  colorPickerWindow.on("closed", () => {
    colorPickerWindow = null;
  });
}

// Ensure only a single instance (prevents multiple tray icons/windows)
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(() => {
  ensureUserDataJson();
  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (mainWindow === null) {
    createWindow();
  }
});

ipcMain.on("log", (event, message) => {
  console.log(message);
});

ipcMain.on("color-selected", (event, color) => {
  mainWindow.webContents.send("color-selected", color);
});

ipcMain.on("Load-Settings-Data-Request", (event) => {
  mainWindow.webContents.send("Start-Up-Data", loadData());
});
