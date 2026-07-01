"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MolekuleHomebridgePlatform = void 0;
const settings_1 = require("./settings");
const platformAccessory_1 = require("./platformAccessory");
const cognito_1 = require("./cognito");
const devices_json_1 = require("./devices.json");
let intervalID;
const Models = devices_json_1.models;
const refreshInterval = 60; //token refresh interval in minutes
const defaultPollInterval = 30; //device state poll interval in seconds
/**
 * HomebridgePlatform
 * This class is the main constructor for your plugin, this is where you should
 * parse the user config and discover/register accessories with Homebridge.
 */
class MolekuleHomebridgePlatform {
    constructor(log, config, api, requester = new cognito_1.HttpAJAX(log, config)) {
        this.log = log;
        this.config = config;
        this.api = api;
        this.requester = requester;
        this.Service = this.api.hap.Service;
        this.Characteristic = this.api.hap.Characteristic;
        // this is used to track restored cached accessories
        this.accessories = [];
        // active accessory handlers, driven by the shared poll loop
        this.handlers = [];
        // When this event is fired it means Homebridge has restored all cached accessories from disk.
        // Dynamic Platform plugins should only register new accessories after this event was fired,
        // in order to ensure they weren't added to homebridge already. This event can also be used
        // to start discovery of new accessories.
        this.api.on("didFinishLaunching", async () => {
            log.debug("Executed didFinishLaunching callback");
            // Don't start until configured — avoids error spam (and satisfies the
            // Homebridge verification "won't start without configuration" rule).
            if (!config.email || !config.password) {
                this.log.error("Missing 'email' and/or 'password' in the Molekule config — the platform will not start until configured.");
                return;
            }
            // run the method to discover / register your devices as accessories
            await this.discoverDevices().catch((e) => this.log.error("Device discovery failed: " + e));
            this.startPolling();
            if (!intervalID)
                intervalID = setInterval(() => this.requester
                    .refreshIdToken()
                    .catch((e) => this.log.debug("Token refresh failed: " + e)), refreshInterval * 60 * 1000);
        });
        this.log.debug("Finished initializing platform ", settings_1.PLATFORM_NAME);
    }
    /**
     * This function is invoked when homebridge restores cached accessories from disk at startup.
     * It should be used to setup event handlers for characteristics and update respective values.
     */
    configureAccessory(accessory) {
        this.log.info("Loading accessory from cache:", accessory.displayName);
        // add the restored accessory to the accessories cache so we can track if it has already been registered
        this.accessories.push(accessory);
    }
    /**
     * This is an example method showing how to register discovered accessories.
     * Accessories must only be registered once, previously created accessories
     * must not be registered again to prevent "duplicate UUID" errors.
     */
    async discoverDevices() {
        this.log.debug("Discover Devices Called");
        const response = await this.requester.httpCall("GET", "", "", 1);
        // loop over the discovered devices and register each one if it has not already been registered
        if (response.status !== 200) {
            this.log.error("Fatal error, discover devices failed. HTTP Status code: " + response.status + " Response: " + JSON.stringify(response.body));
            return; //prevent crashes
        }
        let devicesQuery;
        try {
            devicesQuery = (await response.json());
        }
        catch (e) {
            this.log.error("Failed to parse the device list response: " + e);
            return;
        }
        if (!devicesQuery?.content) {
            this.log.error("Device list response had no 'content'; skipping discovery.");
            return;
        }
        this.log.debug(JSON.stringify(devicesQuery));
        // UUIDs we want to keep this run; anything cached but not listed here is removed.
        const keep = new Set();
        devicesQuery.content.forEach((device) => {
            try {
                this.log.debug("found device from API: " + JSON.stringify(device));
                if (this.config.excludeAirMiniPlus && device.model === "Air Mini Pro") {
                    this.log.info("Excluding Air Mini+ device:", device.name);
                    return; // not kept -> removed by the cleanup pass below
                }
                device.capabilities = Models[device.model];
                if (!device.capabilities) {
                    this.log.info("The device", device.name, "is not a known model. Using default values.");
                }
                // Main air-purifier accessory.
                const uuid = this.api.hap.uuid.generate(device.serialNumber);
                keep.add(uuid);
                const accessory = this.getOrAddAccessory(uuid, device.name, device);
                this.handlers.push(new platformAccessory_1.MolekulePlatformAccessory(this, accessory, this.config, this.log, this.requester));
            }
            catch (e) {
                this.log.error("Failed to set up device " + (device?.name ?? "?") + ": " + e);
            }
        });
        // Remove any cached accessories that are no longer wanted (device gone,
        // excluded, or Quiet Mode disabled).
        this.accessories.forEach((accessory) => {
            if (!keep.has(accessory.UUID)) {
                this.log.warn("Removing accessory:", accessory.displayName);
                this.api.unregisterPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, [
                    accessory,
                ]);
            }
        });
    }
    /**
     * Restore a cached accessory (refreshing its context) or create and register a
     * new one for the given UUID.
     */
    getOrAddAccessory(uuid, displayName, device) {
        const existing = this.accessories.find((a) => a.UUID === uuid);
        if (existing) {
            this.log.info("Restoring existing accessory from cache:", existing.displayName);
            existing.context.device = device;
            this.api.updatePlatformAccessories([existing]);
            return existing;
        }
        this.log.info("Adding new accessory:", displayName);
        const accessory = new this.api.platformAccessory(displayName, uuid);
        accessory.context.device = device;
        this.api.registerPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, [accessory]);
        return accessory;
    }
    /**
     * Poll the Molekule API once per interval and push fresh state to every
     * accessory. HomeKit getters then just return cached state, so a burst of
     * reads no longer produces a burst of API requests.
     */
    startPolling() {
        if (this.pollTimer || this.handlers.length === 0)
            return;
        const seconds = Math.max(5, Number(this.config.pollInterval ?? defaultPollInterval));
        this.log.debug("Polling device state every " + seconds + "s");
        this.poll();
        this.pollTimer = setInterval(() => this.poll(), seconds * 1000);
    }
    async poll() {
        const response = await this.requester.httpCall("GET", "", "", 1);
        if (response.status !== 200) {
            this.log.debug("Poll failed, HTTP status " + response.status);
            return;
        }
        let query;
        try {
            query = (await response.json());
        }
        catch (e) {
            this.log.debug("Poll response parse failed: " + e);
            return;
        }
        if (!query?.content)
            return;
        for (const handler of this.handlers) {
            try {
                await handler.updateFromQuery(query);
            }
            catch (e) {
                this.log.debug("Failed to update accessory: " + e);
            }
        }
    }
}
exports.MolekuleHomebridgePlatform = MolekuleHomebridgePlatform;
//# sourceMappingURL=platform.js.map