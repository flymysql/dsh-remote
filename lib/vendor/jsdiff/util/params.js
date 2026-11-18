// Vendored unchanged from jsdiff 9.0.0; BSD-3-Clause. See lib/vendor/jsdiff/LICENSE.
export function generateOptions(options, defaults) {
    if (typeof options === 'function') {
        defaults.callback = options;
    }
    else if (options) {
        for (const name in options) {
            /* istanbul ignore else */
            if (Object.prototype.hasOwnProperty.call(options, name)) {
                defaults[name] = options[name];
            }
        }
    }
    return defaults;
}
