import {AppSetting, Category, Connector, Device, FireLoopRef, Geoloc, Organization, Parser, User} from '../../shared/sdk/models';
import {RealTime} from '../../shared/sdk/services';
import {Subscription} from 'rxjs/Subscription';
import {AppSettingApi, DeviceApi, MessageApi, OrganizationApi, ParserApi, UserApi} from '../../shared/sdk/services/custom';
import {ToasterConfig, ToasterService} from 'angular2-toaster';
import {Component, ElementRef, Inject, OnDestroy, OnInit, ViewChild} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {DOCUMENT} from '@angular/common';
import {saveAs} from 'file-saver';
import {ActivatedRoute} from '@angular/router';
import {FeatureCollection, GeoJson} from '../../_types/map';
import * as moment from 'moment';
import * as mapboxgl from 'mapbox-gl';
import * as mapboxglgeocoder from 'mapbox-gl-geocoder';
import MapboxCircle from 'mapbox-gl-circle';

@Component({
  selector: 'app-devices',
  templateUrl: './devices.component.html',
  styleUrls: ['./devices.component.scss']
})
export class DevicesComponent implements OnInit, OnDestroy {

  private user: User;

  public filterQuery = '';

  public organization: Organization;
  private organizations: Organization[] = [];

  @ViewChild('confirmModal') confirmModal: any;
  @ViewChild('confirmDBModal') confirmDBModal: any;
  @ViewChild('confirmParseModal') confirmParseModal: any;
  @ViewChild('shareDeviceWithOrganizationModal') shareDeviceWithOrganizationModal: any;

  // Flags
  public devicesReady = false;

  private connectors: Connector[] = [];

  private appSettings: AppSetting[] = [];

  private organizationRouteSub: Subscription;
  private categorySub: Subscription;
  private deviceSub: Subscription;
  private deviceReadSub: Subscription;
  private parserSub: Subscription;

  private categories: Category[] = [];
  public devices: Device[] = [];
  private parsers: Parser[] = [];

  private userRef: FireLoopRef<User>;
  private organizationRef: FireLoopRef<Organization>;
  private categoryRef: FireLoopRef<Category>;
  private deviceRef: FireLoopRef<Device>;
  private deviceReadRef: FireLoopRef<Device>;
  private parserRef: FireLoopRef<Parser>;

  public deviceToEdit: Device = new Device();
  public deviceToRemove: Device = new Device();

  public selectOrganizations: Array<any> = [];
  public selectedOrganizations: Array<any> = [];

  public edit = false;
  private loadingFromBackend = false;
  private loadingParseMessages = false;
  private loadingDownload = false;

  // Notifications
  private toast;
  private toasterService: ToasterService;
  public toasterconfig: ToasterConfig =
    new ToasterConfig({
      tapToDismiss: true,
      timeout: 5000,
      animation: 'fade'
    });

  public selectOrganizationsSettings = {
    singleSelection: false,
    text: 'Select organizations',
    selectAllText: 'Select all',
    unSelectAllText: 'Unselect all',
    enableSearchFilter: true,
    classes: 'select-organization'
  };

  // Map
  private map: mapboxgl.Map;
  private mapStyle = 'mapbox://styles/adechassey/cjjpmejlv0znf2rqmu5cw7scc';
  private mapZoom = 3;
  private mapLat = 48.864716;
  private mapLng = 2.349014;
  private markers: any = [];
  private circle: any;
  private bounds = new mapboxgl.LngLatBounds();

  constructor(private rt: RealTime,
              private userApi: UserApi,
              private organizationApi: OrganizationApi,
              private parserApi: ParserApi,
              private appSettingApi: AppSettingApi,
              private deviceApi: DeviceApi,
              private elRef: ElementRef,
              toasterService: ToasterService,
              @Inject(DOCUMENT) private document: any,
              private messageApi: MessageApi,
              private route: ActivatedRoute,
              private http: HttpClient) {
    this.toasterService = toasterService;
  }

  ngOnInit(): void {
    console.log('Devices: ngOnInit');
    // Get the logged in User object
    this.user = this.userApi.getCachedCurrent();

    // Get the user connectors
    this.userApi.getConnectors(this.user.id).subscribe((connectors: Connector[]) => {
      this.connectors = connectors;
    });

    // Get app settings
    this.appSettingApi.find({where: {key: 'showDeviceSuccessRate'}}).subscribe((appSettings: AppSetting[]) => {
      this.appSettings = appSettings;
      console.log(this.appSettings);
    });

    // Init map
    this.initializeMap();

    // Check if organization view
    this.organizationRouteSub = this.route.parent.parent.params.subscribe(parentParams => {
      if (parentParams.id) {
        this.userApi.findByIdOrganizations(this.user.id, parentParams.id).subscribe((organization: Organization) => {
          this.organization = organization;
          // Check if real time and setup
          if (this.rt.connection.isConnected() && this.rt.connection.authenticated)
            this.setup();
          else
            this.rt.onAuthenticated().subscribe(() => this.setup());
        });
      } else {
        // Check if real time and setup
        if (this.rt.connection.isConnected() && this.rt.connection.authenticated)
          this.setup();
        else
          this.rt.onAuthenticated().subscribe(() => this.setup());
      }
    });
  }

  initializeMap() {
    (mapboxgl as any).accessToken = 'pk.eyJ1IjoiYWRlY2hhc3NleSIsImEiOiJjamdwMjRwb2wwZnVyMndvMjNwM3Vsd2E0In0.jtoBHsEvHPFJ72sRSDPP9Q';
    /// create map
    this.map = new mapboxgl.Map({
      container: 'map',
      style: this.mapStyle,
      zoom: this.mapZoom,
      center: [this.mapLng, this.mapLat]
    });
    /// locate the user
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(position => {
        this.mapLat = position.coords.latitude;
        this.mapLng = position.coords.longitude;
        this.map.flyTo({center: [this.mapLng, this.mapLat]});
      });
    }
    /// Add map controls
    this.map.addControl(new mapboxglgeocoder({
      accessToken: mapboxgl.accessToken
    }));
    this.map.addControl(new mapboxgl.NavigationControl());
    this.map.addControl(new mapboxgl.FullscreenControl());

    /// Add realtime firebase data on map load
    this.map.on('load', (event) => {

      /// register source
      this.map.addSource('geolocs', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: []
        }
      });
      this.map.addLayer({
        id: 'geolocs',
        source: 'geolocs',
        type: 'symbol',
        layout: {
          'text-field': '{title}',
          'text-size': 12,
          'text-transform': 'uppercase',
          'text-offset': [0, 1.3],
          'icon-image': 'marker-gps-2',
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
          'text-allow-overlap': false,
          'text-ignore-placement': false,
          'text-optional': true
        },
        paint: {
          'icon-color': {'type': 'identity', 'property': 'color'},
          'text-color': {'type': 'identity', 'property': 'color'},
          'text-halo-color': '#fff',
          'text-halo-width': 2
        }
      });
    });

    // When a click event occurs on a feature in the places layer, open a popup at the
    // location of the feature, with description HTML from its properties.
    this.map.on('click', 'geolocs', (e) => {
      const coordinates = e.features[0].geometry.coordinates.slice();
      const description = e.features[0].properties.description;

      // Ensure that if the map is zoomed out such that multiple
      // copies of the feature are visible, the popup appears
      // over the copy being pointed to.
      while (Math.abs(e.lngLat.lng - coordinates[0]) > 180) {
        coordinates[0] += e.lngLat.lng > coordinates[0] ? 360 : -360;
      }

      new mapboxgl.Popup()
        .setLngLat(coordinates)
        .setHTML(description)
        .addTo(this.map);
    });

    // Change the cursor to a pointer when the mouse is over the places layer.
    this.map.on('mouseenter', 'geolocs', (e) => {
      this.map.getCanvas().style.cursor = 'pointer';
      if (e.features[0].properties.accuracy) {
        this.circle =  new MapboxCircle({lat: e.features[0].geometry.coordinates.slice()[1], lng: e.features[0].geometry.coordinates.slice()[0]},
          e.features[0].properties.accuracy,
          {fillColor: e.features[0].properties.color}).addTo(this.map);
      } else {
        this.circle = undefined;
      }
    });

    // Change it back to a pointer when it leaves.
    this.map.on('mouseleave', 'geolocs', () => {
      this.map.getCanvas().style.cursor = '';
      if (this.circle) {
        this.circle.remove();
      }
    });
  }

  feedMap() {
    /// subscribe to realtime database and set data source
    this.devices.forEach((device: Device) => {
      device.Messages[0].Geolocs.forEach((geoloc: Geoloc) => {
        const properties = {
          icon: 'marker-15',
          color: '#a31148',
          title: geoloc.deviceId,
          description: '',
          accuracy: 0
        };

        switch (geoloc.type) {
          case 'sigfox':
            properties.icon = 'marker-sigfox';
            properties.color = '#792FAA';
            if (device.name) {
              properties.description = '<strong><b>ID: </b><span class="text-device">' + device.id + '</span></strong>' +
                '                    <br>' +
                '                    <strong *ngIf="device.name"><b>Name: </b>' + device.name + '</strong>' +
                '                    <br *ngIf="device.name">' +
                '                    <strong><b>Type: </b><span class="text-geoloc-sigfox">Sigfox</span></strong>' +
                '                    <br>' +
                '                    <strong><b>Date: </b>' + moment(geoloc.createdAt).format('d/MM/YY') + '</strong>' +
                '                    <br>' +
                '                    <strong><b>Time: </b>' + moment(geoloc.createdAt).format('HH:mm:ss') + '</strong>' +
                '                    <br>' +
                '                    <strong><b>Accuracy: </b>' + geoloc.accuracy + ' m</strong>';
              properties.accuracy = geoloc.accuracy;
            } else {
              properties.description = '<strong><b>ID: </b><span class="text-device">' + device.id + '</span></strong>' +
                '                    <br>' +
                '                    <strong><b>Type: </b><span class="text-geoloc-sigfox">Sigfox</span></strong>' +
                '                    <br>' +
                '                    <strong><b>Date: </b>' + moment(geoloc.createdAt).format('d/MM/YY') + '</strong>' +
                '                    <br>' +
                '                    <strong><b>Time: </b>' + moment(geoloc.createdAt).format('HH:mm:ss') + '</strong>' +
                '                    <br>' +
                '                    <strong><b>Accuracy: </b>' + geoloc.accuracy + ' m</strong>';
              properties.accuracy = geoloc.accuracy;
            }
            break;
          case 'gps':
            properties.icon = 'marker-gps';
            properties.color = '#9B7A48';
            if (device.name) {
              properties.description = '<strong><b>ID: </b><span class="text-device">' + device.id + '</span></strong>' +
                '                    <br>' +
                '                    <strong *ngIf="device.name"><b>Name: </b>' + device.name + '</strong>' +
                '                    <br *ngIf="device.name">' +
                '                    <strong><b>Type: </b><span class="text-geoloc-gps">GPS</span></strong>' +
                '                    <br>' +
                '                    <strong><b>Date: </b>' + moment(geoloc.createdAt).format('d/MM/YY') + '</strong>' +
                '                    <br>' +
                '                    <strong><b>Time: </b>' + moment(geoloc.createdAt).format('HH:mm:ss') + '</strong>';
            } else {
              properties.description = '<strong><b>ID: </b><span class="text-device">' + device.id + '</span></strong>' +
                '                    <br>' +
                '                    <strong><b>Type: </b><span class="text-geoloc-gps">GPS</span></strong>' +
                '                    <br>' +
                '                    <strong><b>Date: </b>' + moment(geoloc.createdAt).format('d/MM/YY') + '</strong>' +
                '                    <br>' +
                '                    <strong><b>Time: </b>' + moment(geoloc.createdAt).format('HH:mm:ss') + '</strong>';
            }
            break;
          case 'beacon':
            properties.icon = 'marker-beacon';
            properties.color = '#3C58CE';
            if (device.name) {
              properties.description = '<strong><b>ID: </b><span class="text-device">' + device.id + '</span></strong>' +
                '                    <br>' +
                '                    <strong *ngIf="device.name"><b>Name: </b>' + device.name + '</strong>' +
                '                    <br *ngIf="device.name">' +
                '                    <strong><b>Type: </b><span class="text-geoloc-beacon">Beacon</span></strong>' +
                '                    <br>' +
                '                    <strong><b>Date: </b>' + moment(geoloc.createdAt).format('d/MM/YY') + '</strong>' +
                '                    <br>' +
                '                    <strong><b>Time: </b>' + moment(geoloc.createdAt).format('HH:mm:ss') + '</strong>' +
                '                    <br>' +
                '                    <strong><b>Accuracy: </b>' + geoloc.accuracy + ' m</strong>';
              properties.accuracy = geoloc.accuracy;
            } else {
              properties.description = '<strong><b>ID: </b><span class="text-device">' + device.id + '</span></strong>' +
                '                    <br>' +
                '                    <strong><b>Type: </b><span class="text-geoloc-beacon">Beacon</span></strong>' +
                '                    <br>' +
                '                    <strong><b>Date: </b>' + moment(geoloc.createdAt).format('d/MM/YY') + '</strong>' +
                '                    <br>' +
                '                    <strong><b>Time: </b>' + moment(geoloc.createdAt).format('HH:mm:ss') + '</strong>' +
                '                    <br>' +
                '                    <strong><b>Accuracy: </b>' + geoloc.accuracy + ' m</strong>';
              properties.accuracy = geoloc.accuracy;
            }
            break;
          case 'wifi':
            properties.icon = 'marker-wifi';
            properties.color = '#2F2A30';
            if (device.name) {
              properties.description = '<strong><b>ID: </b><span class="text-device">' + device.id + '</span></strong>' +
                '                    <br>' +
                '                    <strong *ngIf="device.name"><b>Name: </b>' + device.name + '</strong>' +
                '                    <br *ngIf="device.name">' +
                '                    <strong><b>Type: </b><span class="text-geoloc-wifi">WiFi</span></strong>' +
                '                    <br>' +
                '                    <strong><b>Date: </b>' + moment(geoloc.createdAt).format('d/MM/YY') + '</strong>' +
                '                    <br>' +
                '                    <strong><b>Time: </b>' + moment(geoloc.createdAt).format('HH:mm:ss') + '</strong>' +
                '                    <br>' +
                '                    <strong><b>Accuracy: </b>' + geoloc.accuracy + ' m</strong>';
              properties.accuracy = geoloc.accuracy;
            } else {
              properties.description = '<strong><b>ID: </b><span class="text-device">' + device.id + '</span></strong>' +
                '                    <br>' +
                '                    <strong><b>Type: </b><span class="text-geoloc-wifi">WiFi</span></strong>' +
                '                    <br>' +
                '                    <strong><b>Date: </b>' + moment(geoloc.createdAt).format('d/MM/YY') + '</strong>' +
                '                    <br>' +
                '                    <strong><b>Time: </b>' + moment(geoloc.createdAt).format('HH:mm:ss') + '</strong>' +
                '                    <br>' +
                '                    <strong><b>Accuracy: </b>' + geoloc.accuracy + ' m</strong>';
              properties.accuracy = geoloc.accuracy;
            }
            break;
        }
        this.markers.push(new GeoJson('Point', [geoloc.location.lng, geoloc.location.lat], properties));
        this.bounds.extend([geoloc.location.lng, geoloc.location.lat]);
      });
    });
    // get source
    this.map.getSource('geolocs').setData(new FeatureCollection(this.markers));
    this.map.fitBounds(this.bounds);
  }

  download(type: string) {
    this.loadingDownload = true;
    const url = this.document.location.origin + '/api/Devices/download/' + this.deviceToEdit.id + '/' + type + '?access_token=' + this.userApi.getCurrentToken().id;

    this.http.get(url, {responseType: 'blob'}).subscribe(res => {
      const blob: Blob = new Blob([res], {type: 'text/csv'});
      const today = moment().format('YYYY.MM.DD');
      const filename = today + '_' + this.deviceToEdit.id + '_export.csv';
      saveAs(blob, filename);
      this.loadingDownload = false;
    }, err => {
      console.log(err);
      if (this.toast)
        this.toasterService.clear(this.toast.toastId, this.toast.toastContainerId);
      this.toast = this.toasterService.pop('error', 'Error', 'Server error');
      this.loadingDownload = false;
    });
  }

  setup(): void {
    this.cleanSetup();
    console.log('Setup Devices');

    const filter = {
      where: {},
      limit: 1000,
      order: 'updatedAt DESC',
      include: ['Parser', 'Category', 'Organizations', {
        relation: 'Messages',
        scope: {
          limit: 1,
          order: 'createdAt DESC',
          include: [{
            relation: 'Geolocs',
            scope: {
              limit: 5,
              order: 'createdAt DESC'
            }
          }]
        }
      }]
    };

    this.userRef = this.rt.FireLoop.ref<User>(User).make(this.user);
    this.deviceRef = this.userRef.child<Device>('Devices');

    // Get and listen parsers
    this.parserRef = this.rt.FireLoop.ref<Parser>(Parser);
    this.parserSub = this.parserRef.on('change').subscribe((parsers: Parser[]) => {
      this.parsers = parsers;
    });
    // Get and listen user categories
    this.categoryRef = this.userRef.child<Category>('Categories');
    this.categorySub = this.categoryRef.on('change').subscribe((categories: Category[]) => {
      this.categories = categories;
    });

    if (this.organization) {
      this.organizationRef = this.rt.FireLoop.ref<Organization>(Organization).make(this.organization);
      this.deviceRef = this.organizationRef.child<Device>('Devices');
      this.deviceSub = this.deviceRef.on('change', filter).subscribe((devices: Device[]) => {
        this.devices = devices;
        this.devicesReady = true;
        // Init map
        this.feedMap();
      });
    } else {
      this.userApi.countDevices(this.user.id).subscribe((result: any) => {
        if (result.count < 10) {
          filter.where = {userId: this.user.id};
          this.deviceReadRef = this.rt.FireLoop.ref<Device>(Device);
          this.deviceReadSub = this.deviceReadRef.on('change', filter).subscribe((devices: Device[]) => {
            this.devices = devices;
            this.devicesReady = true;
            // Init map
            this.feedMap();
          });
        } else {
          this.deviceSub = this.deviceRef.on('change', filter).subscribe((devices: Device[]) => {
            this.devices = devices;
            this.devicesReady = true;
            // Init map
            this.feedMap();
          });
        }
      });
    }
  }

  ngOnDestroy(): void {
    console.log('Devices: ngOnDestroy');
    if (this.organizationRouteSub) this.organizationRouteSub.unsubscribe();

    this.cleanSetup();
  }

  private cleanSetup() {
    if (this.organizationRef) this.organizationRef.dispose();
    if (this.userRef) this.userRef.dispose();

    if (this.deviceRef) this.deviceRef.dispose();
    if (this.deviceSub) this.deviceSub.unsubscribe();
    if (this.deviceReadRef) this.deviceReadRef.dispose();
    if (this.deviceReadSub) this.deviceReadSub.unsubscribe();

    if (this.parserRef) this.parserRef.dispose();
    if (this.parserSub) this.parserSub.unsubscribe();

    if (this.categoryRef) this.categoryRef.dispose();
    if (this.categorySub) this.categorySub.unsubscribe();
  }

  editDevice(device): void {
    this.edit = true;
    this.deviceToEdit = device;
  }

  updateDevice(): void {
    this.edit = false;
    this.deviceRef.upsert(this.deviceToEdit).subscribe(value => {
      if (this.toast)
        this.toasterService.clear(this.toast.toastId, this.toast.toastContainerId);
      this.toast = this.toasterService.pop('success', 'Success', 'The device was successfully updated.');
    }, err => {
      if (this.toast)
        this.toasterService.clear(this.toast.toastId, this.toast.toastContainerId);
      this.toast = this.toasterService.pop('error', 'Error', 'Not allowed.');
    });
  }

  updateDeviceCategory(): void {
    console.log(this.deviceToEdit.categoryId);
    if (this.deviceToEdit.categoryId) {
      this.userApi.findByIdCategories(this.user.id, this.deviceToEdit.categoryId).subscribe((category: Category) => {
        console.log(category);
        this.deviceToEdit.properties = category.properties;
      }, err => {
        if (this.toast)
          this.toasterService.clear(this.toast.toastId, this.toast.toastContainerId);
        this.toast = this.toasterService.pop('error', 'Error', 'Not allowed.');
      });
    }

    console.log(this.deviceToEdit);
    // this.deviceRef.upsert(device).subscribe();
  }

  showRetrievalModal(): void {
    this.confirmDBModal.show();
  }

  showParseModal(): void {
    this.confirmParseModal.show();
  }

  retrieveMessages(deviceId: string, limit: number, before: number): void {

    this.userApi.getConnectors(this.user.id, {where: {type: 'sigfox-api'}}).subscribe((connectors: Connector[]) => {
      if (connectors.length > 0) {
        this.loadingFromBackend = true;
        this.deviceApi.getMessagesFromSigfoxBackend(deviceId, null, before ? before : null, null).subscribe(result => {
          console.log(result);
          if (result.paging.next) {
            const before = result.paging.next.substring(result.paging.next.indexOf('before=') + 7);
            this.retrieveMessages(deviceId, null, before);
          } else {
            console.log('Finished process');
            this.loadingFromBackend = false;
            if (this.toast)
              this.toasterService.clear(this.toast.toastId, this.toast.toastContainerId);
            this.toast = this.toasterService.pop('success', 'Success', 'Retrieved messages from Sigfox Backend complete.');
          }
        }, err => {
          if (this.toast)
            this.toasterService.clear(this.toast.toastId, this.toast.toastContainerId);
          this.toast = this.toasterService.pop('error', 'Error', err.message.message);
          this.loadingFromBackend = false;
        });
        this.confirmDBModal.hide();
      } else {
        if (this.toast)
          this.toasterService.clear(this.toast.toastId, this.toast.toastContainerId);
        this.toast = this.toasterService.pop('warning', 'Warning', 'Please refer your Sigfox API credentials in the connectors page first.');
      }
    });
  }

  parseAllMessages(deviceId: string): void {
    this.loadingParseMessages = true;
    // Disconnect real-time to avoid app crashing
    this.rt.connection.disconnect();
    this.parserApi.parseAllMessages(deviceId, null, null).subscribe(result => {
      this.loadingParseMessages = false;
      if (result.message === 'Success') {
        if (this.toast)
          this.toasterService.clear(this.toast.toastId, this.toast.toastContainerId);
        this.toast = this.toasterService.pop('success', 'Success', 'All the messages were successfully parsed.');
      } else {
        this.loadingParseMessages = false;
        if (this.toast)
          this.toasterService.clear(this.toast.toastId, this.toast.toastContainerId);
        this.toast = this.toasterService.pop('warning', 'Warning', result.message);
      }
      this.rt.onReady();
      //console.log(result);
    });
    this.confirmParseModal.hide();
  }

  zoomOnDevice(geoloc: Geoloc): void {
    window.scrollTo(0, 0);

  }

  cancel(): void {
    this.edit = false;
  }

  showRemoveModal(device: Device): void {
    this.confirmModal.show();
    this.deviceToRemove = device;
  }

  remove(): void {
    // Delete all messages belonging to the device
    this.deviceRef.remove(this.deviceToRemove).subscribe(value => {
      console.log(value);
      this.edit = false;
      this.confirmModal.hide();
      if (this.toast)
        this.toasterService.clear(this.toast.toastId, this.toast.toastContainerId);
      this.toast = this.toasterService.pop('success', 'Success', 'The device and its messages were successfully deleted.');
    }, err => {
      if (this.toast)
        this.toasterService.clear(this.toast.toastId, this.toast.toastContainerId);
      this.toast = this.toasterService.pop('error', 'Error', 'Not allowed.');
    });
  }

  showShareDeviceWithOrganizationModal(): void{
    this.selectOrganizations = [];
    this.userApi.getOrganizations(this.user.id).subscribe((organizations: Organization[]) => {
      this.organizations = organizations;
      this.organizations.forEach(organization => {
        const item = {
          id: organization.id,
          itemName: organization.name
        };
        let addOrganization = true;
        this.deviceToEdit.Organizations.forEach(deviceOrganization => {
          if (deviceOrganization.id === organization.id) {
            addOrganization = false;
            return;
          }
        });
        if (addOrganization) {
          this.selectOrganizations.push(item);
        }
      });
      this.shareDeviceWithOrganizationModal.show();
    });
  }

  shareDeviceWithOrganization(deviceId): void {
    this.selectedOrganizations.forEach(orga => {
      this.deviceApi.linkOrganizations(deviceId, orga.id).subscribe(results => {
        console.log(results);
        this.shareDeviceWithOrganizationModal.hide();
        this.organizationApi.findById(orga.id).subscribe((org: Organization) => {
          this.deviceToEdit.Organizations.push(org);
        });
        // if(this.deviceToEdit.Organizations){
        //
        // }

      }, err => {
        if (this.toast)
          this.toasterService.clear(this.toast.toastId, this.toast.toastContainerId);
        this.toast = this.toasterService.pop('error', 'Error', err.error);
      });
    });
  }

  unshare(orga, device, index): void {
    this.deviceApi.unlinkOrganizations(device.id, orga.id).subscribe(results => {
      console.log(results);
      if (this.toast)
        this.toasterService.clear(this.toast.toastId, this.toast.toastContainerId);
      this.toast = this.toasterService.pop('success', 'Success', 'The device has been removed from ' + orga.name + '.');
      this.deviceToEdit.Organizations.splice(index, 1);
    }, err => {
      if (this.toast)
        this.toasterService.clear(this.toast.toastId, this.toast.toastContainerId);
      this.toast = this.toasterService.pop('error', 'Error', err.message);
    });
  }

  // getOrganizations(): void {
  //   this.userApi.getOrganizations(this.user.id).subscribe((organizations: Organization[]) => {
  //     this.organizations = organizations;
  //     console.log(organizations);
  //   });
  // }
}
