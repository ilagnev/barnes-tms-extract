const ExportConfig = require('./exportConfig.js');
const {
	ExportMetadata,
	ExportStatus,
} = require('./exportMetadata.js');
const CSVWriter = require('../../../util/csvWriter.js');
const TMSURLReader = require('./tmsURLReader.js');
const WarningReporter = require('./warningReporter.js');
const UpdateEmitter = require('../../../util/updateEmitter.js');
const logger = require('./logger.js');

const config = require('config');
const fs = require('fs');
const path = require('path');
const _ = require('lodash');
const iconv = require('iconv-lite');

function decodeUTF8InterpretedAsWin(str) {
	if (typeof str !== 'string') return str;
	const buf = new Buffer(str);
	const newnewbuf = iconv.encode(buf, 'win-1252');
	return newnewbuf.toString();
}

/**
 * @typedef {object} TMSExporter~TMSCredentials
 * @description Credentials for connecting to a TMS API
 * @property {string} key - TMS key
 * @property {string} username - TMS username
 * @property {string} password - TMS password
 */

/**
 * @typedef {object} TMSExporter~TMSExportStatus
 * @description Status of a running TMS export
 * @property {boolean} active - Whether or not the TMS export script is currently running
 * @property {string} csv - Path to the objects.csv file containing the exported collection objects
 * @property {number} processed - Number of collection objects that have been processed
 * @property {number} total - Totl number of collection objects that will be exported
 * @property {ExportMetadata~ExportStatus} status - Status of the TMS export
 */

/**
 * @typedef {object} TMSExporter~TMSExportConfiguration
 * @description Configures the TMS export process. Specifies the root TMS API URL, the output directory,
 *  debug configuration, which fields to export, and which warnings to generate
 * @property {string} apiURL - The root TMS API URL
 * @property {string} outputDirectory - The directory into which the exported CSV file will be placed
 * @property {object} debug - Debug values (optional)
 * @property {number} debug.limit - Exit after exporting this many collection objects (optional)
 * @property {TMSExporter~TMSFieldExportConfiguration[]} fields - Export configuration for each field that is to be exported
 * @property {object} warnings - Warning flags. Warnings are written to `warnings.csv`
 * @property {boolean} warnings.singletonFields - Emit a warning for fields that only appear a very small number of times
 * @default false
 * @property {boolean} warnings.missingFields - Emit a warning for objects that do not expose a required field
 * @default false
 * @property {boolean} warnings.unusedFields - Emit a warning for fields that are not exported
 * @default false
 */

/**
 * @typedef {object} TMSExporter~TMSFieldExportConfiguration
 * @description Export configuration for a particular TMS field
 * @property {string} name - The name of the field to be exported
 * @property {boolean} primaryKey - Whether this field should be used as a unique identifier for the object (one required)
 * @property {boolean} required - Whether the field must be present (when absent a warning will be generated)
 * @property {boolean} enumerated - Whether the field is expected to have one of a small number of values
 */

/**
 * Manages the export from TMS to a CSV file.
 * @implements {@link UpdateEmitter}
 * @param {TMSCredentials} credentials - Credentials for connecting to the TMS API. These are typically
 *  loaded from `config/credentials.json`, which is encrypted by default
 */
class TMSExporter extends UpdateEmitter {
	constructor(credentials) {
		super();
		this._credentials = credentials;
		this._processedObjectCount = 0;
		this._totalObjectCount = 0;
		this._active = false;
	}

	/**
	 * @property {boolean} active - Whether or not the TMS export script is currently running
	 */
	get active() {
		return this._active;
	}

	/**
	 * @property {string} csvFilePath - Path to the objects.csv file containing the exported collection objects
	 */
	get csvFilePath() {
		return this._csvFilePath;
	}

	/**
	 * @property {TMSExporter~TMSExportStatus} status - Status of the currently running TMSExport status
	 * @override
	 */
	get status() {
		return {
			active: this._active,
			csv: this._csvFilePath,
			processed: this._processedObjectCount,
			total: this._totalObjectCount,
			status: (this._exportMeta ? this._exportMeta.status : null),
		};
	}

	_beginExport(credentials, exportConfig, csvOutputDir) {
		this._active = true;
		this._processedObjectCount = 0;
		this._totalObjectCount = 0;
		this._limitOutput = false;
		this._tms = new TMSURLReader(credentials, exportConfig);
		this._tms.rootURL = exportConfig.apiURL;
		logger.info(`Exporting TMS API from URL ${this._tms.collectionURL}`);
		this._csvFilePath = `${csvOutputDir}/objects.csv`;
		this._csv = new CSVWriter(this._csvFilePath, exportConfig.outputHeaders, logger);
		this._warningReporter = new WarningReporter(csvOutputDir, exportConfig);
		this._exportMeta = new ExportMetadata(`${csvOutputDir}/meta.json`);
		this._exportMeta.status = ExportStatus.INCOMPLETE;
		this._exportMeta.processedObjects = 0;
		this.started();

		return this._countObjects(exportConfig);
	}

	_countObjects(exportConfig) {
		if (exportConfig.debug && exportConfig.debug.limit) {
			this._limitOutput = true;
			this._totalObjectCount = exportConfig.debug.limit;
			this._exportMeta.totalObjects = this._totalObjectCount;
			logger.info(`Limiting output to ${exportConfig.debug.limit} entires`);
			logger.info(`Processing ${this._totalObjectCount} collection objects`);
			return Promise.resolve();
		} else {
			return this._tms.getObjectCount().then((res) => {
				this._totalObjectCount = res;
				this._exportMeta.totalObjects = this._totalObjectCount;
				logger.info(`Processing ${this._totalObjectCount} collection objects`);
			}).catch((err) => {
				logger.error(err);
				this._exportMeta.status = ExportStatus.ERROR;
				return Promise.reject(error);
			});
		}
	}

	_finishExport(config, status) {
		this._active = false;
		this._csv.end();
		this._warningReporter.end();
		this.completed();
		logger.info('CSV export completed', { tag: 'tag:complete' });
		this._exportMeta.status = status;
	}

	_processArtObject(credentials, exportConfig, csvOutputDir, artObject) {
		const id = artObject.descriptionWithFields([exportConfig.primaryKey])[exportConfig.primaryKey];

		const description = artObject.descriptionWithFields(exportConfig.fields);

		if (id === 5189) {
			debugger;
		}

		_.forOwn(description, (value, key) => {
			description[key] = decodeUTF8InterpretedAsWin(value);
		});
		logger.debug(description);
		this._csv.write(description);
		this._warningReporter.appendFieldsForObject(id, artObject, description);
		this._processedObjectCount += 1;
		this._exportMeta.processedObjects = this._processedObjectCount;
		this.progress();
		if (this._processedObjectCount % 100 === 0) {
			logger.info(`Processed ${this._processedObjectCount} of ${this._totalObjectCount} collection objects`);
		}
	}

	_processTMSHelper(credentials, exportConfig, csvOutputDir) {
		if (!this._active) {
			return this._finishExport(exportConfig, ExportStatus.CANCELLED);
		}

		return this._tms.hasNext().then((hasNext) => {
			if (hasNext) {
				return this._tms.next();
			} else {
				this._finishExport(exportConfig, ExportStatus.COMPLETED);
				return null;
			}
		}).catch((error) => {
			logger.error(error);
			logger.info('Error fetching collection data, finishing');
			return this._finishExport(exportConfig, ExportStatus.ERROR);
		}).then((artObject) => {
			if (artObject !== null) {
				this._processArtObject(credentials, exportConfig, csvOutputDir, artObject);
				const reachedLimit = this._limitOutput && this._processedObjectCount >= exportConfig.debug.limit;
				if (reachedLimit) {
					logger.info(`Reached ${this._processedObjectCount} collection objects processed, finishing`);
					this._finishExport(exportConfig, ExportStatus.COMPLETED);
				} else {
					return this._processTMSHelper(credentials, exportConfig, csvOutputDir);
				}
			} else {
				logger.info('Reached the end of the collection, finishing');
			}
		}).catch((error) => {
			logger.warn(error);
			logger.info('Error fetching collection object, skipping');
			return this._processTMSHelper(credentials, exportConfig, csvOutputDir);
		});
	}

	_processTMS(credentials, exportConfig, csvOutputDir) {
		return this._beginExport(credentials, exportConfig, csvOutputDir).then(() => {
			return this._processTMSHelper(credentials, exportConfig, csvOutputDir);
		}).catch((error) => {
			return this._finishExport(exportConfig, ExportStatus.ERROR);
		});
	}

	/**
	 * Stop the running TMS export
	 */
	cancelExport() {
		logger.info('Cancelling CSV export', { tag: 'tag:cancel' });
		this._active = false;
		this._exportMeta.status = ExportStatus.CANCELLED;
	}

	/**
	 * Begin the TMS export process
	 * @param {TMSExporter~TMSExportConfiguration} configJSON - Export configuration
	 * @fires UpdateEmitter#started
	 * @fires UpdateEmitter#progress
	 * @fires UpdateEmitter#completed
	 * @return {Promise} - Resolves when completed
	 */
	exportCSV(configJSON) {
		logger.info('Beginning CSV export', { tag: 'tag:start' });

		const exportConfig = new ExportConfig(configJSON);

		const outputFolderName = `csv_${new Date().getTime()}`;

		const outputPath = path.join(exportConfig.outputDirectory, outputFolderName);

		logger.info(`Reading TMS API from root URL ${exportConfig.apiURL}`);
		logger.info(`Creating CSV output directory ${outputPath}`);
		fs.mkdirSync(outputPath);

		return this._processTMS(this._credentials, exportConfig, outputPath).then(() => this.status);
	}
};

module.exports = TMSExporter;