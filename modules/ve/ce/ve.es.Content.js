/**
 * Creates an ve.es.Content object.
 * 
 * A content view flows text into a DOM element and provides methods to get information about the
 * rendered output. HTML serialized specifically for rendering into and editing surface.
 * 
 * Rendering occurs automatically when content is modified, by responding to "update" events from
 * the model. Rendering is iterative and interruptable to reduce user feedback latency.
 * 
 * TODO: Cleanup code and comments
 * 
 * @class
 * @constructor
 * @param {jQuery} $container Element to render into
 * @param {ve.ModelNode} model Model to produce view for
 * @property {jQuery} $
 * @property {ve.ContentModel} model
 * @property {Array} boundaries
 * @property {Array} lines
 * @property {Integer} width
 * @property {RegExp} bondaryTest
 * @property {Object} widthCache
 * @property {Object} renderState
 * @property {Object} contentCache
 */
ve.es.Content = function( $container, model ) {
	// Inheritance
	ve.EventEmitter.call( this );

	// Properties
	this.$ = $container;
	this.model = model;
	this.boundaries = [];
	this.lines = [];
	this.width = null;
	this.boundaryTest = /([ \-\t\r\n\f])/g;
	this.widthCache = {};
	this.renderState = {};
	this.contentCache = null;

	if ( model ) {
		// Events
		var _this = this;
		this.model.on( 'update', function( offset ) {
			_this.render( offset || 0 );
		} );

		// Initialization
		this.scanBoundaries();
	}
};

/* Static Members */

/**
 * List of annotation rendering implementations.
 * 
 * Each supported annotation renderer must have an open and close property, each either a string or
 * a function which accepts a data argument.
 * 
 * @static
 * @member
 */
ve.es.Content.annotationRenderers = {
	'object/template': {
		'open': function( data ) {
			return '<span class="es-contentView-format-object">' + data.html;
		},
		'close': '</span>'
	},
	'object/hook': {
		'open': function( data ) {
			return '<span class="es-contentView-format-object">' + data.html;
		},
		'close': '</span>'
	},
	'textStyle/bold': {
		'open': '<span class="es-contentView-format-textStyle-bold">',
		'close': '</span>'
	},
	'textStyle/italic': {
		'open': '<span class="es-contentView-format-textStyle-italic">',
		'close': '</span>'
	},
	'textStyle/strong': {
		'open': '<span class="es-contentView-format-textStyle-strong">',
		'close': '</span>'
	},
	'textStyle/emphasize': {
		'open': '<span class="es-contentView-format-textStyle-emphasize">',
		'close': '</span>'
	},
	'textStyle/big': {
		'open': '<span class="es-contentView-format-textStyle-big">',
		'close': '</span>'
	},
	'textStyle/small': {
		'open': '<span class="es-contentView-format-textStyle-small">',
		'close': '</span>'
	},
	'textStyle/superScript': {
		'open': '<span class="es-contentView-format-textStyle-superScript">',
		'close': '</span>'
	},
	'textStyle/subScript': {
		'open': '<span class="es-contentView-format-textStyle-subScript">',
		'close': '</span>'
	},
	'link/external': {
		'open': function( data ) {
			return '<span class="es-contentView-format-link" data-href="' + data.href + '">';
		},
		'close': '</span>'
	},
	'link/internal': {
		'open': function( data ) {
			return '<span class="es-contentView-format-link" data-title="wiki/' + data.title + '">';
		},
		'close': '</span>'
	}
};

/**
 * Mapping of character and HTML entities or renderings.
 * 
 * @static
 * @member
 */
ve.es.Content.htmlCharacters = {
	'&': '&amp;',
	'<': '&lt;',
	'>': '&gt;',
	'\'': '&#039;',
	'"': '&quot;',
	'\n': '<span class="es-contentView-whitespace">&#182;</span>',
	'\t': '<span class="es-contentView-whitespace">&#8702;</span>',
	//' ': '&nbsp;'
};

/* Static Methods */

/**
 * Gets a rendered opening or closing of an annotation.
 * 
 * Tag nesting is handled using a stack, which keeps track of what is currently open. A common stack
 * argument should be used while rendering content.
 * 
 * @static
 * @method
 * @param {String} bias Which side of the annotation to render, either "open" or "close"
 * @param {Object} annotation Annotation to render
 * @param {Array} stack List of currently open annotations
 * @returns {String} Rendered annotation
 */
ve.es.Content.renderAnnotation = function( bias, annotation, stack ) {
	var renderers = ve.es.Content.annotationRenderers,
		type = annotation.type,
		out = '';
	if ( type in renderers ) {
		if ( bias === 'open' ) {
			// Add annotation to the top of the stack
			stack.push( annotation );
			// Open annotation
			out += typeof renderers[type].open === 'function' ?
				renderers[type].open( annotation.data ) : renderers[type].open;
		} else {
			if ( stack[stack.length - 1] === annotation ) {
				// Remove annotation from top of the stack
				stack.pop();
				// Close annotation
				out += typeof renderers[type].close === 'function' ?
					renderers[type].close( annotation.data ) : renderers[type].close;
			} else {
				// Find the annotation in the stack
				var depth = ve.inArray( annotation, stack ),
					i;
				if ( depth === -1 ) {
					throw 'Invalid stack error. An element is missing from the stack.';
				}
				// Close each already opened annotation
				for ( i = stack.length - 1; i >= depth + 1; i-- ) {
					out += typeof renderers[stack[i].type].close === 'function' ?
						renderers[stack[i].type].close( stack[i].data ) :
							renderers[stack[i].type].close;
				}
				// Close the buried annotation
				out += typeof renderers[type].close === 'function' ?
					renderers[type].close( annotation.data ) : renderers[type].close;
				// Re-open each previously opened annotation
				for ( i = depth + 1; i < stack.length; i++ ) {
					out += typeof renderers[stack[i].type].open === 'function' ?
						renderers[stack[i].type].open( stack[i].data ) :
							renderers[stack[i].type].open;
				}
				// Remove the annotation from the middle of the stack
				stack.splice( depth, 1 );
			}
		}
	}
	return out;
};

/* Methods */

/**
 * Updates the word boundary cache, which is used for word fitting.
 * 
 * @method
 */
ve.es.Content.prototype.scanBoundaries = function() {
	/*
	 * Word boundary scan
	 * 
	 * To perform binary-search on words, rather than characters, we need to collect word boundary
	 * offsets into an array. The offset of the right side of the breaking character is stored, so
	 * the gaps between stored offsets always include the breaking character at the end.
	 * 
	 * To avoid encoding the same words as HTML over and over while fitting text to lines, we also
	 * build a list of HTML escaped strings for each gap between the offsets stored in the
	 * "boundaries" array. Slices of the "words" array can be joined, producing the escaped HTML of
	 * the words.
	 */
	// Get and cache a copy of all content, the make a plain-text version of the cached content
	var data = this.contentCache = this.model.getContentData(),
		text = '';
	for ( var i = 0, length = data.length; i < length; i++ ) {
		text += typeof data[i] === 'string' ? data[i] : data[i][0];
	}
	// Purge "boundaries" and "words" arrays
	this.boundaries = [0];
	// Reset RegExp object's state
	this.boundaryTest.lastIndex = 0;
	// Iterate over each word+boundary sequence, capturing offsets and encoding text as we go
	var match,
		end;
	while ( ( match = this.boundaryTest.exec( text ) ) ) {
		// Include the boundary character in the range
		end = match.index + 1;
		// Store the boundary offset
		this.boundaries.push( end );
	}
	// If the last character is not a boundary character, we need to append the final range to the
	// "boundaries" and "words" arrays
	if ( end < text.length || this.boundaries.length === 1 ) {
		this.boundaries.push( text.length );
	}
};

ve.es.Content.prototype.render = function( offset ) {
	this.$.html( this.getHtml( 0, this.model.getContentLength() ) );
};

/**
 * Gets an HTML rendering of a range of data within content model.
 * 
 * @method
 * @param {ve.Range} range Range of content to render
 * @param {String} Rendered HTML of data within content model
 */
ve.es.Content.prototype.getHtml = function( range, options ) {
	if ( range ) {
		range.normalize();
	} else {
		range = { 'start': 0, 'end': undefined };
	}
	var data = this.contentCache.slice( range.start, range.end ),
		render = ve.es.Content.renderAnnotation,
		htmlChars = ve.es.Content.htmlCharacters;
	var out = '',
		left = '',
		right,
		leftPlain,
		rightPlain,
		stack = [],
		chr,
		i,
		j;
	for ( i = 0; i < data.length; i++ ) {
		right = data[i];
		leftPlain = typeof left === 'string';
		rightPlain = typeof right === 'string';
		if ( !leftPlain && rightPlain ) {
			// [formatted][plain] pair, close any annotations for left
			for ( j = 1; j < left.length; j++ ) {
				out += render( 'close', left[j], stack );
			}
		} else if ( leftPlain && !rightPlain ) {
			// [plain][formatted] pair, open any annotations for right
			for ( j = 1; j < right.length; j++ ) {
				out += render( 'open', right[j], stack );
			}
		} else if ( !leftPlain && !rightPlain ) {
			// [formatted][formatted] pair, open/close any differences
			for ( j = 1; j < left.length; j++ ) {
				if ( ve.inArray( left[j], right ) === -1 ) {
					out += render( 'close', left[j], stack );
				}
			}
			for ( j = 1; j < right.length; j++ ) {
				if ( ve.inArray( right[j], left ) === -1 ) {
					out += render( 'open', right[j], stack );
				}
			}
		}
		chr = rightPlain ? right : right[0];
		out += chr in htmlChars ? htmlChars[chr] : chr;
		left = right;
	}
	// Close all remaining tags at the end of the content
	if ( !rightPlain && right ) {
		for ( j = 1; j < right.length; j++ ) {
			out += render( 'close', right[j], stack );
		}
	}
	return out;
};

/* Inheritance */

ve.extendClass( ve.es.Content, ve.EventEmitter );