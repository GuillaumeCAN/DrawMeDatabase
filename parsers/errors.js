//
// Copyright (c) 2025 Guillaume Cancalon - All rights reserved
//
// This file is part of DrawMeDatabase, and is released under the "GNU GENERAL PUBLIC LICENSE".
// Please see the LICENSE file that should have been included as part of this package.
//

// Error with a message meant to be shown to the user as is (missing folder, no files...)
class ParserError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ParserError';
    }
}

module.exports = { ParserError };
