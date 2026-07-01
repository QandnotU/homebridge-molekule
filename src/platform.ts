import type {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
} from "homebridge";
import { PLATFORM_NAME, PLUGIN_NAME } from "./settings";
import { MolekulePlatformAccessory } from "./platformAccessory";
import { HttpAJAX } from "./cognito";
import { models } from "./devices.json";

export interface queryResponse {
  content: deviceData[];
}
interface deviceData {
  name: string;
  model: string;
  serialNumber: string;
  auto: string;
  pecoFilter: string;
  fanspeed: string;
  mode: string;
  online: string;
  aqi: string;
  silent: string;
  capabilities: capabilities;
}
interface capabilities {
  MaxFanSpeed: number;
  AutoFunctionality: number;
  AirQualityMonitor: number;
}

interface JsonData {
  [deviceName: string]: capabilities;
}
let intervalID: NodeJS.Timeout;
const Models: JsonData = models;
const refreshInterval = 60; //token refresh interval in minutes
const defaultPollInterval = 30; //device state poll interval in seconds
/**
 * HomebridgePlatform
 * This class is the main constructor for your plugin, this is where you should
 * parse the user config and discover/register accessories with Homebridge.
 */
export class MolekuleHomebridgePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic =
    this.api.hap.Characteristic;
  // this is used to track restored cached accessories
  public readonly accessories: PlatformAccessory[] = [];
  // active accessory handlers, driven by the shared poll loop
  private readonly handlers: MolekulePlatformAccessory[] = [];
  private pollTimer?: NodeJS.Timeout;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
    public readonly requester = new HttpAJAX(log, config),
  ) {
    // When this event is fired it means Homebridge has restored all cached accessories from disk.
    // Dynamic Platform plugins should only register new accessories after this event was fired,
    // in order to ensure they weren't added to homebridge already. This event can also be used
    // to start discovery of new accessories.
    this.api.on("didFinishLaunching", async () => {
      log.debug("Executed didFinishLaunching callback");
      // run the method to discover / register your devices as accessories
      await this.discoverDevices();
      this.startPolling();
      if (!intervalID)
        intervalID = setInterval(
          () => this.requester.refreshIdToken(),
          refreshInterval * 60 * 1000,
        );
    });
    this.log.debug("Finished initializing platform ", PLATFORM_NAME);
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to setup event handlers for characteristics and update respective values.
   */

  configureAccessory(accessory: PlatformAccessory) {
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
      this.log.error(
        "Fatal error, discover devices failed. HTTP Status code: " + response.status + " Response: " + JSON.stringify(response.body),
      );
      return; //prevent crashes
    }
    const devicesQuery = (await response.json()) as queryResponse;
    this.log.debug(JSON.stringify(devicesQuery));

    // UUIDs we want to keep this run; anything cached but not listed here is removed.
    const keep = new Set<string>();

    devicesQuery.content.forEach((device: deviceData) => {
      this.log.debug("found device from API: " + JSON.stringify(device));

      if (this.config.excludeAirMiniPlus && device.model === "Air Mini Pro") {
        this.log.info("Excluding Air Mini+ device:", device.name);
        return; // not kept -> removed by the cleanup pass below
      }

      device.capabilities = Models[device.model];
      if (!device.capabilities) {
        this.log.info(
          "The device",
          device.name,
          "is not a known model. Using default values.",
        );
      }

      // Main air-purifier accessory.
      const uuid = this.api.hap.uuid.generate(device.serialNumber);
      keep.add(uuid);
      const accessory = this.getOrAddAccessory(uuid, device.name, device);
      this.handlers.push(
        new MolekulePlatformAccessory(
          this,
          accessory,
          this.config,
          this.log,
          this.requester,
        ),
      );
    });

    // Remove any cached accessories that are no longer wanted (device gone,
    // excluded, or Quiet Mode disabled).
    this.accessories.forEach((accessory: PlatformAccessory) => {
      if (!keep.has(accessory.UUID)) {
        this.log.warn("Removing accessory:", accessory.displayName);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
          accessory,
        ]);
      }
    });
  }

  /**
   * Restore a cached accessory (refreshing its context) or create and register a
   * new one for the given UUID.
   */
  private getOrAddAccessory(
    uuid: string,
    displayName: string,
    device: deviceData,
  ): PlatformAccessory {
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
    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    return accessory;
  }

  /**
   * Poll the Molekule API once per interval and push fresh state to every
   * accessory. HomeKit getters then just return cached state, so a burst of
   * reads no longer produces a burst of API requests.
   */
  private startPolling() {
    if (this.pollTimer || this.handlers.length === 0) return;
    const seconds = Math.max(5, Number(this.config.pollInterval ?? defaultPollInterval));
    this.log.debug("Polling device state every " + seconds + "s");
    this.poll();
    this.pollTimer = setInterval(() => this.poll(), seconds * 1000);
  }

  private async poll() {
    const response = await this.requester.httpCall("GET", "", "", 1);
    if (response.status !== 200) {
      this.log.debug("Poll failed, HTTP status " + response.status);
      return;
    }
    let query: queryResponse;
    try {
      query = (await response.json()) as queryResponse;
    } catch (e) {
      this.log.debug("Poll response parse failed: " + e);
      return;
    }
    if (!query?.content) return;
    for (const handler of this.handlers) {
      try {
        await handler.updateFromQuery(query);
      } catch (e) {
        this.log.debug("Failed to update accessory: " + e);
      }
    }
  }
}
