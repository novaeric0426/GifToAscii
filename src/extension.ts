import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { GifReader } from 'omggif';

export function activate(context: vscode.ExtensionContext) {
    console.log('High Resolution GIF to ASCII extension is now active');

    // Register command to convert GIF to ASCII art
    let disposable = vscode.commands.registerCommand('gif-to-ascii.convert', async () => {
        // Ask user to select a GIF file
        const fileUri = await vscode.window.showOpenDialog({
            canSelectMany: false,
            filters: { 'GIF Images': ['gif'] }
        });

        if (!fileUri || fileUri.length === 0) {
            return;
        }

        // Create and show webview panel in secondary sidebar
        const panel = vscode.window.createWebviewPanel(
            'asciiArtView',
            'ASCII Art View',
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        // Let user choose resolution settings
        const resolutionOptions = ['Standard', 'High Resolution', 'Ultra HD'];
        const resolutionChoice = await vscode.window.showQuickPick(resolutionOptions, {
            placeHolder: 'Select ASCII art resolution'
        });
        
        let resolutionSettings;
        switch(resolutionChoice) {
            case 'Ultra HD':
                resolutionSettings = {
                    // Extended ASCII character set for more granular brightness levels
                    asciiChars: '$@B%8&WM#*oahkbdpqwmZO0QLCJUYXzcvunxrjft/\\|()1{}[]?-_+~<>i!lI;:,"^`\'. ',
                    maxWidth: 250,
                    fontRatio: 0.5 // Adjust for monospace font width/height ratio
                };
                break;
            case 'High Resolution':
                resolutionSettings = {
                    asciiChars: '@%#*+=-:. ',
                    maxWidth: 160,
                    fontRatio: 0.6
                };
                break;
            default: // Standard
                resolutionSettings = {
                    asciiChars: '@%#*+=-:. ',
                    maxWidth: 80,
                    fontRatio: 0.6
                };
                break;
        }

        // Process GIF and convert to ASCII
        try {
            const filePath = fileUri[0].fsPath;
            const fileData = fs.readFileSync(filePath);
            const buffer = Buffer.from(fileData);
            const gifReader = new GifReader(new Uint8Array(buffer));
            
            // Get GIF info
            const frameCount = gifReader.numFrames();
            const width = gifReader.width;
            const height = gifReader.height;
            
            // Show loading indicator
            panel.webview.html = getLoadingContent();
            
            // Prepare first frame
            const firstFrame = new Uint8Array(width * height * 4);
            gifReader.decodeAndBlitFrameRGBA(0, firstFrame);
            
            // Convert first frame to ASCII
            const asciiArt = convertFrameToAscii(firstFrame, width, height, resolutionSettings);
            
            // Calculate optimal font size for the webview
            const fontSize = calculateOptimalFontSize(width, height, resolutionSettings);
            
            // Load HTML content with ASCII art
            panel.webview.html = getWebviewContent(
                asciiArt, 
                width, 
                height, 
                frameCount, 
                fontSize,
                resolutionSettings
            );
            
            // Set up message passing for animation
            panel.webview.onDidReceiveMessage(
                message => {
                    if (message.command === 'getFrame') {
                        const frameIndex = message.frameIndex % frameCount;
                        const frameData = new Uint8Array(width * height * 4);
                        const frameInfo = gifReader.frameInfo(frameIndex);
                        gifReader.decodeAndBlitFrameRGBA(frameIndex, frameData);
                        
                        const asciiFrame = convertFrameToAscii(frameData, width, height, resolutionSettings);
                        panel.webview.postMessage({ 
                            command: 'updateFrame', 
                            asciiFrame,
                            delay: frameInfo.delay * 10 // Convert to ms
                        });
                    }
                },
                undefined,
                context.subscriptions
            );
        } catch (error) {
            vscode.window.showErrorMessage(`Error processing GIF: ${error}`);
        }
    });

    context.subscriptions.push(disposable);
}

function getLoadingContent(): string {
    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Loading...</title>
        <style>
            body {
                background-color: var(--vscode-editor-background);
                color: var(--vscode-editor-foreground);
                font-family: sans-serif;
                display: flex;
                justify-content: center;
                align-items: center;
                height: 100vh;
                margin: 0;
            }
            .loader {
                font-size: 24px;
                font-weight: bold;
            }
        </style>
    </head>
    <body>
        <div class="loader">Processing GIF, please wait...</div>
    </body>
    </html>`;
}

function convertFrameToAscii(
    frameData: Uint8Array, 
    width: number, 
    height: number, 
    settings: {asciiChars: string, maxWidth: number, fontRatio: number}
): string {
    const { asciiChars, maxWidth, fontRatio } = settings;
    let asciiArt = '';
    
    // Calculate ideal dimensions based on font ratio
    const maxHeight = Math.floor(maxWidth * (height / width) / fontRatio);
    
    // Calculate scale factors
    const horizontalScale = width / maxWidth;
    const verticalScale = height / maxHeight;
    
    // Apply bicubic sampling for higher quality
    for (let y = 0; y < maxHeight; y++) {
        for (let x = 0; x < maxWidth; x++) {
            // Sample with improved algorithm
            const sampledColor = samplePixel(frameData, x, y, width, height, horizontalScale, verticalScale);
            
            // Convert to brightness value (weighted RGB)
            const brightness = 0.299 * sampledColor.r + 0.587 * sampledColor.g + 0.114 * sampledColor.b;
            
            // Convert brightness to character index
            const charIndex = Math.floor((brightness / 255) * (asciiChars.length - 1));
            asciiArt += asciiChars[charIndex];
        }
        asciiArt += '\n';
    }
    
    return asciiArt;
}

function samplePixel(
    frameData: Uint8Array,
    targetX: number,
    targetY: number, 
    width: number,
    height: number,
    horizontalScale: number,
    verticalScale: number
): {r: number, g: number, b: number} {
    // Map to source coordinates
    const srcX = targetX * horizontalScale;
    const srcY = targetY * verticalScale;
    
    // Get integer parts (for pixel boundaries)
    const x1 = Math.floor(srcX);
    const y1 = Math.floor(srcY);
    const x2 = Math.min(x1 + 1, width - 1);
    const y2 = Math.min(y1 + 1, height - 1);
    
    // Get fractional parts (for interpolation)
    const xFrac = srcX - x1;
    const yFrac = srcY - y1;
    
    // Sample the four surrounding pixels
    const p11 = getPixel(frameData, x1, y1, width);
    const p12 = getPixel(frameData, x1, y2, width);
    const p21 = getPixel(frameData, x2, y1, width);
    const p22 = getPixel(frameData, x2, y2, width);
    
    // Bilinear interpolation
    const r = bilinearInterpolate(p11.r, p21.r, p12.r, p22.r, xFrac, yFrac);
    const g = bilinearInterpolate(p11.g, p21.g, p12.g, p22.g, xFrac, yFrac);
    const b = bilinearInterpolate(p11.b, p21.b, p12.b, p22.b, xFrac, yFrac);
    
    return { r, g, b };
}

function getPixel(frameData: Uint8Array, x: number, y: number, width: number): {r: number, g: number, b: number} {
    const idx = (y * width + x) * 4;
    return {
        r: frameData[idx],
        g: frameData[idx + 1],
        b: frameData[idx + 2]
    };
}

function bilinearInterpolate(
    p11: number, p21: number, p12: number, p22: number, 
    xFrac: number, yFrac: number
): number {
    const top = p11 * (1 - xFrac) + p21 * xFrac;
    const bottom = p12 * (1 - xFrac) + p22 * xFrac;
    return Math.round(top * (1 - yFrac) + bottom * yFrac);
}

function calculateOptimalFontSize(
    width: number, 
    height: number, 
    settings: {maxWidth: number, fontRatio: number, asciiChars?: string}
): number {
    // Calculate base on screen dimensions and resolution settings
    // Start with a reasonable default
    const baseSize = 14;
    
    if (settings.maxWidth > 160) {
        return 8; // Smaller font for ultra HD
    } else if (settings.maxWidth > 80) {
        return 10; // Medium font for high resolution
    }
    return baseSize; // Standard font size
}

function getWebviewContent(
    initialAscii: string, 
    width: number, 
    height: number, 
    frameCount: number, 
    fontSize: number,
    settings: {maxWidth: number, asciiChars?: string, fontRatio?: number}
): string {
    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>ASCII Art View</title>
        <style>
            body {
                background-color: var(--vscode-editor-background);
                color: var(--vscode-editor-foreground);
                font-family: monospace;
                padding: 10px;
                margin: 0;
                overflow-x: auto;
            }
            pre {
                white-space: pre;
                font-size: ${fontSize}px;
                line-height: 1;
                margin: 0;
                letter-spacing: 0;
            }
            .controls {
                margin-bottom: 10px;
                position: sticky;
                top: 0;
                background-color: var(--vscode-editor-background);
                padding: 5px 0;
                z-index: 10;
                display: flex;
                flex-wrap: wrap;
                gap: 10px;
                align-items: center;
            }
            button {
                background-color: var(--vscode-button-background);
                color: var(--vscode-button-foreground);
                border: none;
                padding: 4px 10px;
                cursor: pointer;
                border-radius: 2px;
            }
            button:hover {
                background-color: var(--vscode-button-hoverBackground);
            }
            .slider-container {
                display: flex;
                align-items: center;
                gap: 5px;
            }
            #fontSizeSlider {
                width: 80px;
            }
            .color-toggle {
                margin-left: auto;
            }
            .inverted {
                background-color: var(--vscode-editor-foreground);
                color: var(--vscode-editor-background);
            }
        </style>
    </head>
    <body>
        <div class="controls">
            <button id="playPauseBtn">Play Animation</button>
            <span>Frame: <span id="frameCounter">0</span>/${frameCount}</span>
            <div class="slider-container">
                <label for="speedSlider">Speed:</label>
                <input type="range" id="speedSlider" min="0.25" max="2" step="0.25" value="1">
                <span id="speedValue">1x</span>
            </div>
            <div class="slider-container">
                <label for="fontSizeSlider">Font:</label>
                <input type="range" id="fontSizeSlider" min="6" max="20" value="${fontSize}">
                <span id="fontSizeValue">${fontSize}px</span>
            </div>
            <button id="invertBtn">Invert Colors</button>
        </div>
        <pre id="asciiOutput">${initialAscii}</pre>
        
        <script>
            (function() {
                const vscode = acquireVsCodeApi();
                const playPauseBtn = document.getElementById('playPauseBtn');
                const asciiOutput = document.getElementById('asciiOutput');
                const frameCounter = document.getElementById('frameCounter');
                const speedSlider = document.getElementById('speedSlider');
                const speedValue = document.getElementById('speedValue');
                const fontSizeSlider = document.getElementById('fontSizeSlider');
                const fontSizeValue = document.getElementById('fontSizeValue');
                const invertBtn = document.getElementById('invertBtn');
                
                let isPlaying = false;
                let currentFrame = 0;
                let animationInterval;
                
                // Handle play/pause button
                playPauseBtn.addEventListener('click', () => {
                    if (isPlaying) {
                        clearInterval(animationInterval);
                        playPauseBtn.textContent = 'Play Animation';
                    } else {
                        animationInterval = setInterval(() => {
                            currentFrame = (currentFrame + 1) % ${frameCount};
                            frameCounter.textContent = currentFrame;
                            vscode.postMessage({ command: 'getFrame', frameIndex: currentFrame });
                        }, 100); // 10 fps, adjust as needed
                        playPauseBtn.textContent = 'Pause Animation';
                    }
                    isPlaying = !isPlaying;
                });
                
                // Handle messages from extension
                window.addEventListener('message', event => {
                    const message = event.data;
                    switch (message.command) {
                        case 'updateFrame':
                            asciiOutput.textContent = message.asciiFrame;
                            break;
                    }
                });
            }());
        </script>
    </body>
    </html>`;
}

export function deactivate() {}