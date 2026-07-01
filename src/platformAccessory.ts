import type {
  Service,
  PlatformAccessory,
  CharacteristicValue,
  Logger,
  PlatformConfig,
  WithUUID,
} from "homebridge";
import { HttpAJAX } from "./cognito";
import { MolekuleHomebridgePlatform, queryResponse } from "./platform";
import { aqiReport } from "./aqiReport";

/**
 * Platform Accessory
 * An instance of this class is created for each accessory the platform registers.
 * Each Molekule device is modelled as an AirPurifier plus, depending on the
 * device's capabilities, linked FilterMaintenance / AirQualitySensor /
 * CarbonDioxideSensor / HumiditySensor services (and an optional Quiet switch).
 */
export class MolekulePlatformAccessory {
  private service: Service;
  private filterService?: Service;
  private aqiService?: Service;
  private co2Service?: Service;
  private humidityService?: Service;

  private maxSpeed =
    this.accessory.context.device.capabilities?.MaxFanSpeed ?? 6; //defaults to max speed of 6 if device not in JSON
  private state = {
    state: 0, //https://developers.homebridge.io/#/characteristic/CurrentAirPurifierState
    Speed: 0,
    Filter: 100,
    On: 0,
    auto: 0,
    silent: 0,
    airQuality: 0,
  };
  private readonly aqiClass = new aqiReport(this.requester);

  constructor(
    private readonly platform: MolekuleHomebridgePlatform,
    private readonly accessory: PlatformAccessory,
    private readonly config: PlatformConfig,
    private readonly log: Logger,
    private readonly requester: HttpAJAX,
  ) {
    const C = this.platform.Characteristic;
    const S = this.platform.Service;
    const name = accessory.context.device.name;
    const aq = this.accessory.context.device.capabilities?.AirQualityMonitor ?? 0;

    // HomeKit's FirmwareRevision only accepts up to three numeric components
    // (major.minor.revision). Molekule reports four (e.g. "9.4.32.3"), which the
    // Home app rejects and renders as "0.0" — trim to the first three.
    const firmware =
      String(accessory.context.device.firmwareVersion ?? "")
        .split(".")
        .slice(0, 3)
        .join(".") || "0.0.0";

    // set accessory information
    this.accessory
      .getService(S.AccessoryInformation)!
      .setCharacteristic(C.Manufacturer, "Molekule")
      // Prefer the marketing product name (e.g. "Molekule Air Pro") over the
      // internal model codename (e.g. "Sequoia Basic") for the HomeKit tile.
      .setCharacteristic(
        C.Model,
        accessory.context.device.subProduct?.name ||
          accessory.context.device.model,
      )
      .setCharacteristic(C.SerialNumber, accessory.context.device.serialNumber)
      .setCharacteristic(C.FirmwareRevision, firmware);

    // Recreate the AirPurifier service fresh each launch so capability changes
    // (and stale characteristics from older plugin versions) are cleared.
    const oldPurifier = this.accessory.getService(S.AirPurifier);
    if (oldPurifier) this.accessory.removeService(oldPurifier);
    this.service = this.accessory.addService(S.AirPurifier);
    this.service.setCharacteristic(C.Name, name);

    this.service
      .getCharacteristic(C.Active)
      .onSet(this.handleActiveSet.bind(this))
      .onGet(this.handleActiveGet.bind(this));
    this.service
      .getCharacteristic(C.CurrentAirPurifierState)
      .onGet(this.getState.bind(this));
    if (this.accessory.context.device.capabilities?.AutoFunctionality ?? false) {
      this.service
        .getCharacteristic(C.TargetAirPurifierState)
        .onSet(this.handleAutoSet.bind(this))
        .onGet(this.handleAutoGet.bind(this));
    }
    this.service
      .getCharacteristic(C.RotationSpeed)
      .onSet(this.setSpeed.bind(this))
      .onGet(this.getSpeed.bind(this));

    // FilterChangeIndication / FilterLifeLevel belong to FilterMaintenance, not
    // AirPurifier — expose them on a linked FilterMaintenance service.
    this.filterService = this.linkSensor(
      this.accessory.getService(S.FilterMaintenance) ||
        this.accessory.addService(S.FilterMaintenance),
    );
    this.filterService
      .getCharacteristic(C.FilterChangeIndication)
      .onGet(this.getFilterChange.bind(this));
    this.filterService
      .getCharacteristic(C.FilterLifeLevel)
      .onGet(this.getFilterStatus.bind(this));

    // Air-quality data lives on its own sensor services (never on AirPurifier,
    // where these characteristics are not permitted).
    if (aq >= 1) {
      this.aqiService = this.linkSensor(
        this.accessory.getService(S.AirQualitySensor) ||
          this.accessory.addService(S.AirQualitySensor, name + " Air Quality"),
        name + " Air Quality",
      );
      this.aqiService.getCharacteristic(C.AirQuality).onGet(this.getAirQuality.bind(this));
      // Pre-declare the optional characteristics we publish so HomeKit advertises
      // them from the start rather than on first update.
      this.aqiService.getCharacteristic(C.PM2_5Density);
      this.aqiService.getCharacteristic(C.StatusActive);
      this.aqiService.getCharacteristic(C.StatusFault);
      if (aq === 1) {
        this.aqiService.getCharacteristic(C.PM10Density);
        this.aqiService.getCharacteristic(C.VOCDensity);
      }
    } else {
      this.removeService(S.AirQualitySensor);
    }

    // CO2 and humidity are only reported by the full-sensor devices (Air Pro).
    if (aq === 1) {
      this.co2Service = this.linkSensor(
        this.accessory.getService(S.CarbonDioxideSensor) ||
          this.accessory.addService(S.CarbonDioxideSensor, name + " CO2"),
        name + " CO2",
      );
      this.co2Service.getCharacteristic(C.CarbonDioxideLevel);
      this.co2Service.getCharacteristic(C.StatusActive);
      this.co2Service.getCharacteristic(C.StatusFault);
      this.humidityService = this.linkSensor(
        this.accessory.getService(S.HumiditySensor) ||
          this.accessory.addService(S.HumiditySensor, name + " Humidity"),
        name + " Humidity",
      );
      this.humidityService.getCharacteristic(C.StatusActive);
      this.humidityService.getCharacteristic(C.StatusFault);
    } else {
      this.removeService(S.CarbonDioxideSensor);
      this.removeService(S.HumiditySensor);
    }

    // The Quiet switch is now published as its own "Quiet Mode" accessory
    // (see MolekuleQuietSwitch), so remove any legacy switch that older versions
    // linked onto this accessory.
    const legacyQuiet = this.accessory.getServiceById(S.Switch, "quiet");
    if (legacyQuiet) this.accessory.removeService(legacyQuiet);
  }

  /** Name a sensor service and link it to the AirPurifier. */
  private linkSensor(svc: Service, name?: string): Service {
    if (name) svc.setCharacteristic(this.platform.Characteristic.Name, name);
    this.service.addLinkedService(svc);
    return svc;
  }

  private removeService(type: WithUUID<typeof Service>): void {
    const svc = this.accessory.getService(type);
    if (svc) this.accessory.removeService(svc);
  }

  /** Map Molekule's coarse aqi label to a HomeKit AirQuality level. */
  private aqiFromLabel(label: string): number {
    const { AirQuality } = this.platform.Characteristic;
    switch (label) {
      case "good":
        return AirQuality.EXCELLENT;
      case "moderate":
        return AirQuality.FAIR;
      case "bad":
        return AirQuality.INFERIOR;
      case "very bad":
        return AirQuality.POOR;
      default:
        return AirQuality.UNKNOWN;
    }
  }

  /** Derive a finer HomeKit AirQuality level from PM2.5 (µg/m³, EPA breakpoints). */
  private aqiFromPm25(pm: number): number {
    const { AirQuality } = this.platform.Characteristic;
    if (pm < 0) return AirQuality.UNKNOWN;
    if (pm <= 12) return AirQuality.EXCELLENT;
    if (pm <= 35.4) return AirQuality.GOOD;
    if (pm <= 55.4) return AirQuality.FAIR;
    if (pm <= 150.4) return AirQuality.INFERIOR;
    return AirQuality.POOR;
  }

  /** Reflect online/offline on the sensor services via StatusActive/StatusFault. */
  private setSensorStatus(online: boolean): void {
    const { StatusActive, StatusFault } = this.platform.Characteristic;
    const fault = online
      ? StatusFault.NO_FAULT
      : StatusFault.GENERAL_FAULT;
    for (const svc of [this.aqiService, this.co2Service, this.humidityService]) {
      svc?.updateCharacteristic(StatusActive, online);
      svc?.updateCharacteristic(StatusFault, fault);
    }
  }

  /**
   * Refresh cached state from a shared device-list response and push the new
   * values to HomeKit. Called by the platform's poll loop — HomeKit getters
   * themselves just return the cached state so they stay fast.
   */
  async updateFromQuery(query: queryResponse): Promise<void> {
    const C = this.platform.Characteristic;
    const device = query.content?.find(
      (d) => d.serialNumber === this.accessory.context.device.serialNumber,
    );
    if (!device) {
      this.accessory.context.device.online = "false";
      this.setSensorStatus(false);
      return;
    }

    device.capabilities = this.accessory.context.device.capabilities;
    this.accessory.context.device = device;
    const online = device.online === "true";

    this.state.Speed = (+device.fanspeed * 100) / this.maxSpeed;
    this.state.Filter = +device.pecoFilter;
    this.state.auto = +(device.mode === "smart");
    this.state.silent = +(device.silent === "1");
    if (device.mode !== "off") {
      this.state.On = C.Active.ACTIVE;
      this.state.state = C.CurrentAirPurifierState.PURIFYING_AIR;
    } else {
      this.state.On = C.Active.INACTIVE;
      this.state.state = C.CurrentAirPurifierState.INACTIVE;
    }
    // Coarse label-based AQI; overridden by PM2.5 in updateAirQuality when a
    // sensor reading is available.
    this.state.airQuality = this.aqiFromLabel(device.aqi);

    if (!online)
      this.log.warn(device.name + " was reported offline by the Molekule API.");

    this.service.updateCharacteristic(C.RotationSpeed, this.state.Speed);
    this.service.updateCharacteristic(C.CurrentAirPurifierState, this.state.state);
    this.service.updateCharacteristic(C.Active, this.state.On);
    if ((device.capabilities?.AutoFunctionality ?? 0) !== 0)
      this.service.updateCharacteristic(C.TargetAirPurifierState, this.state.auto);

    this.filterService?.updateCharacteristic(C.FilterLifeLevel, this.state.Filter);
    this.filterService?.updateCharacteristic(
      C.FilterChangeIndication,
      this.getFilterChange(),
    );

    this.setSensorStatus(online);

    // Air-quality values come from a separate per-device endpoint.
    if (this.aqiService) await this.updateAirQuality();

    this.log.debug(device.name, this.state);
  }

  /** Fetch and publish the latest air-quality sensor readings. */
  async updateAirQuality(): Promise<void> {
    const C = this.platform.Characteristic;
    let stats: Record<string, number>;
    try {
      stats = await this.aqiClass.getAqi(this.accessory.context.device.serialNumber);
    } catch (e) {
      this.log.debug(
        this.accessory.context.device.name,
        "AQI fetch failed:",
        e as string,
      );
      return;
    }
    this.log.debug(this.accessory.context.device.name, stats);

    if (this.aqiService) {
      const pm25 = stats["PM2_5"] ?? 0;
      this.aqiService.updateCharacteristic(C.PM2_5Density, pm25);
      // Molekule frequently reports PM2.5 = 0 while VOC/CO2 are elevated, so a
      // PM2.5-only score would read "Excellent" when the device says otherwise.
      // Report the worse of the PM2.5-derived level and Molekule's own aqi label.
      this.state.airQuality = Math.max(
        this.aqiFromPm25(pm25),
        this.aqiFromLabel(this.accessory.context.device.aqi),
      );
      this.aqiService.updateCharacteristic(C.AirQuality, this.state.airQuality);
      // PM10 / VOC are only present on the full-sensor devices.
      if ((this.accessory.context.device.capabilities?.AirQualityMonitor ?? 0) === 1) {
        this.aqiService.updateCharacteristic(C.PM10Density, stats["PM10"] ?? 0);
        this.aqiService.updateCharacteristic(C.VOCDensity, stats["TVOC"] ?? 0);
      }
    }
    if (this.co2Service) {
      const co2 = stats["CO2"] ?? 0;
      this.co2Service.updateCharacteristic(C.CarbonDioxideLevel, co2);
      this.co2Service.updateCharacteristic(
        C.CarbonDioxideDetected,
        co2 > Number(this.config.co2Threshold ?? 1000)
          ? C.CarbonDioxideDetected.CO2_LEVELS_ABNORMAL
          : C.CarbonDioxideDetected.CO2_LEVELS_NORMAL,
      );
    }
    this.humidityService?.updateCharacteristic(
      C.CurrentRelativeHumidity,
      stats["RH"] ?? 0,
    );
  }

  async handleActiveSet(value: CharacteristicValue) {
    const { CurrentAirPurifierState, Active } = this.platform.Characteristic;
    const response = await this.requester.httpCall(
      "POST",
      this.accessory.context.device.serialNumber + "/actions/set-power-status",
      JSON.stringify({ status: value ? "on" : "off" }),
      1,
    );
    if (response.status === 204) {
      this.platform.log.info(
        this.accessory.context.device.name + " power set ->",
        value ? "on" : "off",
      );
      this.service.updateCharacteristic(Active, value);
      if (value) {
        this.service.updateCharacteristic(
          CurrentAirPurifierState,
          CurrentAirPurifierState.PURIFYING_AIR,
        );
        this.state.state = CurrentAirPurifierState.PURIFYING_AIR;
        this.state.On = Active.ACTIVE;
      } else {
        this.service.updateCharacteristic(
          CurrentAirPurifierState,
          CurrentAirPurifierState.INACTIVE,
        );
        this.state.On = Active.INACTIVE;
      }
    }
  }

  /**
   * GET handlers return cached state so they respond instantly; the platform's
   * poll loop keeps that state fresh and pushes updates via updateCharacteristic.
   */
  handleActiveGet(): CharacteristicValue {
    if (this.accessory.context.device.online !== "true") {
      this.log.warn(this.accessory.context.device.name, "is offline");
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
    return this.state.On;
  }

  getState(): CharacteristicValue {
    return this.state.state;
  }

  async handleAutoSet(value: CharacteristicValue) {
    const { TargetAirPurifierState, RotationSpeed } = this.platform.Characteristic;
    let responseCode;
    const clamp = Math.round(
      Math.min(
        Math.max(this.state.Speed / (100 / this.maxSpeed), 1),
        this.maxSpeed,
      ),
    );
    switch (
      this.accessory.context.device.capabilities?.AutoFunctionality ?? (0 as number)
    ) {
      case 1:
        if (value === TargetAirPurifierState.AUTO)
          responseCode = (
            await this.requester.httpCall(
              "POST",
              this.accessory.context.device.serialNumber +
                "/actions/enable-smart-mode",
              "",
              1,
            )
          ).status;
        else {
          responseCode = (
            await this.requester.httpCall(
              "POST",
              this.accessory.context.device.serialNumber +
                "/actions/set-fan-speed",
              JSON.stringify({ fanSpeed: clamp }),
              1,
            )
          ).status;
          this.service.updateCharacteristic(RotationSpeed, this.state.Speed);
        }
        break;
      case 2:
        if (value === TargetAirPurifierState.AUTO)
          responseCode = (
            await this.requester.httpCall(
              "POST",
              this.accessory.context.device.serialNumber +
                "/actions/enable-smart-mode",
              JSON.stringify({ silent: String(Number(this.config.silentAuto ?? false)) }),
              1,
            )
          ).status;
        else {
          responseCode = (
            await this.requester.httpCall(
              "POST",
              this.accessory.context.device.serialNumber +
                "/actions/set-fan-speed",
              JSON.stringify({ fanSpeed: clamp }),
              1,
            )
          ).status;
          this.service.updateCharacteristic(RotationSpeed, this.state.Speed);
        }
        break;
      default:
        this.log.error(
          "Homekit attempted to set auto/manual (" +
            value +
            ") state but your device doesn't support it ☹",
        );
        this.service.updateCharacteristic(
          TargetAirPurifierState,
          TargetAirPurifierState.MANUAL,
        );
        break;
    }
    if (responseCode === 204 || responseCode === 200) {
      this.state.auto = value as number;
      this.service.updateCharacteristic(TargetAirPurifierState, this.state.auto);
      this.platform.log.info(
        this.accessory.context.device.name,
        "set",
        value ? "auto" : "manual",
        "state.",
      );
    } else {
      this.log.error(
        this.accessory.context.device.name,
        "failed to set auto/manual state",
      );
      this.service.updateCharacteristic(TargetAirPurifierState, this.state.auto);
    }
  }

  handleAutoGet(): CharacteristicValue {
    return this.state.auto;
  }

  async setSpeed(value: CharacteristicValue) {
    const clamp = Math.round(
      Math.min(
        Math.max((value as number) / (100 / this.maxSpeed), 1),
        this.maxSpeed,
      ),
    );
    if (
      (
        await this.requester.httpCall(
          "POST",
          this.accessory.context.device.serialNumber + "/actions/set-fan-speed",
          JSON.stringify({ fanSpeed: clamp }),
          1,
        )
      ).status === 204
    )
      this.state.Speed = (clamp * 100) / this.maxSpeed;
    this.platform.log.info(
      this.accessory.context.device.name + " set speed -> ",
      JSON.stringify({ fanSpeed: clamp }),
    );
    this.service.updateCharacteristic(
      this.platform.Characteristic.RotationSpeed,
      this.state.Speed,
    );
  }

  getSpeed(): CharacteristicValue {
    return this.state.Speed;
  }

  getFilterChange(): CharacteristicValue {
    const { FilterChangeIndication } = this.platform.Characteristic;
    if (this.state.Filter > (this.config.threshold ?? 10))
      return FilterChangeIndication.FILTER_OK;
    else return FilterChangeIndication.CHANGE_FILTER;
  }

  getFilterStatus(): CharacteristicValue {
    this.platform.log.debug(
      this.accessory.context.device.name,
      "Filter State:",
      this.state.Filter,
    );
    return this.state.Filter;
  }

  getAirQuality(): CharacteristicValue {
    return this.state.airQuality;
  }
}

/**
 * Standalone "Quiet Mode" accessory for Air Pro devices (silent auto). Exposed as
 * its own accessory rather than a switch on the purifier so it gets its own tile.
 * Turning it on enables Auto + Quiet; the purifier's auto state reconciles on the
 * next poll.
 */
export class MolekuleQuietSwitch {
  private service: Service;
  private silent = 0;

  constructor(
    private readonly platform: MolekuleHomebridgePlatform,
    private readonly accessory: PlatformAccessory,
    private readonly log: Logger,
    private readonly requester: HttpAJAX,
  ) {
    const C = this.platform.Characteristic;
    const S = this.platform.Service;
    const device = accessory.context.device;

    this.accessory
      .getService(S.AccessoryInformation)!
      .setCharacteristic(C.Manufacturer, "Molekule")
      .setCharacteristic(C.Model, (device.subProduct?.name || device.model) + " Quiet")
      .setCharacteristic(C.SerialNumber, device.serialNumber + "-quiet");

    this.service =
      this.accessory.getService(S.Switch) ||
      this.accessory.addService(S.Switch, "Quiet Mode");
    this.service.setCharacteristic(C.Name, "Quiet Mode");
    this.service
      .getCharacteristic(C.On)
      .onGet(() => !!this.silent)
      .onSet(this.setQuiet.bind(this));
  }

  async setQuiet(value: CharacteristicValue) {
    const response = await this.requester.httpCall(
      "POST",
      this.accessory.context.device.serialNumber + "/actions/enable-smart-mode",
      JSON.stringify({ silent: value ? "1" : "0" }),
      1,
    );
    if (response.status === 204 || response.status === 200) {
      this.silent = value ? 1 : 0;
      this.platform.log.info(
        this.accessory.context.device.name,
        "quiet",
        value ? "on" : "off",
        "(auto enabled)",
      );
    } else {
      this.log.error(this.accessory.context.device.name, "failed to set quiet mode");
      this.service.updateCharacteristic(this.platform.Characteristic.On, !!this.silent);
    }
  }

  async updateFromQuery(query: queryResponse): Promise<void> {
    const device = query.content?.find(
      (d) => d.serialNumber === this.accessory.context.device.serialNumber,
    );
    if (!device) return;
    this.silent = +(device.silent === "1");
    this.service.updateCharacteristic(
      this.platform.Characteristic.On,
      !!this.silent,
    );
  }
}
