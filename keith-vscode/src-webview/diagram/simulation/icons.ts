/*
 * KIELER - Kiel Integrated Environment for Layout Eclipse RichClient
 *
 * http://rtsys.informatik.uni-kiel.de/kieler
 *
 * Copyright 2026 by
 * + Kiel University
 *   + Department of Computer Science
 *     + Real-Time and Embedded Systems Group
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * SPDX-License-Identifier: EPL-2.0
 */

// Inlined from @vscode/codicons/src/icons. The webview's content security policy has no
// font-src, so the codicon font never loads; inline SVG needs no font at all.

export const ICONS: Record<string, string> = {
    play: '<path d="M3.78 2L3 2.41v12l.78.42 9-6V8l-9-6zM4 13.48V3.35l7.6 5.07L4 13.48z"/>',
    'debug-restart':
        '<path fill-rule="evenodd" clip-rule="evenodd" d="M12.75 8a4.5 4.5 0 0 1-8.61 1.834l-1.391.565A6.001 6.001 0 0 0 14.25 8 6 6 0 0 0 3.5 4.334V2.5H2v4l.75.75h3.5v-1.5H4.352A4.5 4.5 0 0 1 12.75 8z"/>',
    'debug-step-over':
        '<path fill-rule="evenodd" clip-rule="evenodd" d="M14.25 5.75v-4h-1.5v2.542c-1.145-1.359-2.911-2.209-4.84-2.209-3.177 0-5.92 2.307-6.16 5.398l-.02.269h1.501l.022-.226c.212-2.195 2.202-3.94 4.656-3.94 1.736 0 3.244.875 4.05 2.166h-2.83v1.5h4.163l.962-.975V5.75h-.004zM8 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"/>',
    'debug-start':
        '<path fill-rule="evenodd" clip-rule="evenodd" d="M4.25 3l1.166-.624 8 5.333v1.248l-8 5.334-1.166-.624V3zm1.5 1.401v7.864l5.898-3.932L5.75 4.401z"/>',
    'debug-pause': '<path d="M4.5 3H6v10H4.5V3zm7 0v10H10V3h1.5z"/>',
    'debug-stop':
        '<path fill-rule="evenodd" clip-rule="evenodd" d="M13 1.99976L14 2.99976V12.9998L13 13.9998H3L2 12.9998L2 2.99976L3 1.99976H13ZM12.7461 3.25057L3.25469 3.25057L3.25469 12.7504H12.7461V3.25057Z"/>',
    watch: '<path d="M7.5 9h2V8H8V5.5H7v3l.5.5z"/><path fill-rule="evenodd" clip-rule="evenodd" d="M5.5 3.669A4.998 4.998 0 0 0 3 8a4.998 4.998 0 0 0 2.5 4.331V14.5l.5.5h4l.5-.5v-2.169A4.998 4.998 0 0 0 13 8a4.998 4.998 0 0 0-2.5-4.331V1.5L10 1H6l-.5.5v2.169zM12 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0z"/>',
    save: '<path fill-rule="evenodd" clip-rule="evenodd" d="M13.353 1.146l1.5 1.5L15 3v11.5l-.5.5h-13l-.5-.5v-13l.5-.5H13l.353.146zM2 2v12h12V3.208L12.793 2H11v4H4V2H2zm6 0v3h2V2H8z"/>',
    'folder-opened':
        '<path d="M1.5 14h11l.48-.37 2.63-7-.48-.63H14V3.5l-.5-.5H7.71l-.86-.85L6.5 2h-5l-.5.5v11l.5.5zM2 3h4.29l.86.85.35.15H13v2H8.5l-.35.15-.86.85H3.5l-.47.34-1 3.08L2 3zm10.13 10H2.19l1.67-5H7.5l.35-.15.86-.85h5.79l-2.37 6z"/>',
    'link-external':
        '<path d="M1.5 1H6v1H2v12h12v-4h1v4.5l-.5.5h-13l-.5-.5v-13l.5-.5z"/><path d="M15 1.5V8h-1V2.707L7.243 9.465l-.707-.708L13.293 2H8V1h6.5l.5.5z"/>',
    'layout-panel':
        '<path fill-rule="evenodd" clip-rule="evenodd" d="M2 1L1 2V14L2 15H14L15 14V2L14 1H2ZM2 10V2H14V10H2Z"/>',
    'circuit-board':
        '<path d="M14.5 1h-13l-.5.5v13l.5.5h13l.5-.5v-13l-.5-.5zM14 14H5v-2h2.3c.3.6 1 1 1.7 1 1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2H4v3H2V2h2v2.3c-.6.3-1 1-1 1.7 0 1.1.9 2 2 2s2-.9 2-2h2c0 1.1.9 2 2 2s2-.9 2-2-.9-2-2-2c-.7 0-1.4.4-1.7 1H6.7c-.3-.6-1-1-1.7-1V2h9v12zm-6-3c0-.6.4-1 1-1s1 .4 1 1-.4 1-1 1-1-.4-1-1zM5 5c.6 0 1 .4 1 1s-.4 1-1 1-1-.4-1-1 .4-1 1-1zm6 0c.6 0 1 .4 1 1s-.4 1-1 1-1-.4-1-1 .4-1 1-1z"/>',
    loading:
        '<path fill-rule="evenodd" clip-rule="evenodd" d="M13.917 7A6.002 6.002 0 0 0 2.083 7H1.071a7.002 7.002 0 0 1 13.858 0h-1.012z"/>',
    warning:
        '<path fill-rule="evenodd" clip-rule="evenodd" d="M7.56 1h.88l6.54 12.26-.44.74H1.44L1 13.26 7.56 1zM8 2.28L2.28 13H13.7L8 2.28zM8.625 12v-1h-1.25v1h1.25zm-1.25-2V6h1.25v4h-1.25z"/>',
    'symbol-misc':
        '<path fill-rule="evenodd" clip-rule="evenodd" d="M4 2h8v4c.341.035.677.112 1 .23V1H3v8.48l1-1.75V2zm2.14 8L5 8 4 9.75 3.29 11 1 15h8l-2.29-4-.57-1zm-3.42 4l1.72-3L5 10l.56 1 1.72 3H2.72zm6.836-6.41a3.5 3.5 0 1 1 3.888 5.82 3.5 3.5 0 0 1-3.888-5.82zm.555 4.989a2.5 2.5 0 1 0 2.778-4.157 2.5 2.5 0 0 0-2.778 4.157z"/>',
}
