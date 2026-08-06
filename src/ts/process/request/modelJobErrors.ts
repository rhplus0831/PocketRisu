import { language } from 'src/lang'

/** The journal tail ended while the server still owns the generation. */
export class ModelJobConnectionLostError extends Error {
    constructor() {
        super(language.errors.modelJobConnectionLost)
        this.name = 'ModelJobConnectionLostError'
    }
}
