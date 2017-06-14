import * as assert from 'assert';
import * as createDebug from 'debug';
import { pluralize } from 'inflection';
import {
  kebabCase,
  startCase,
  lowerFirst } from 'lodash';
import DenaliObject from '../metal/object';
import ORMAdapter from './orm-adapter';
import { RelationshipDescriptor, AttributeDescriptor } from './descriptors';
import Container from '../metal/container';

const debug = createDebug('denali:model');

/**
 * The Model class is the core of Denali's unique approach to data and ORMs. It acts as a wrapper
 * and translation layer that provides a unified interface to access and manipulate data, but
 * translates those interactions into ORM specific operations via ORM adapters.
 *
 * Models are able to maintain their relatively clean interface thanks to the way the constructor
 * actually returns a Proxy which wraps the Model instance, rather than the Model instance directly.
 * This means you can directly get and set properties on your records, and the record (which is a
 * Proxy-wrapped Model) will translate and forward those calls to the underlying ORM adapter.
 *
 * @package data
 */
export default class Model extends DenaliObject {

  [key: string]: any;

  /**
   * Alias for this.constructor.type
   */
  get type(): string {
    return this.container.metaFor(this.constructor).containerName;
  }

  /**
   * Marks the Model as an abstract base model, so ORM adapters can know not to create tables or
   * other supporting infrastructure.
   */
  static abstract = false;

  /**
   * The ORM adapter specific to this model type. Defaults to the application's ORM adapter if none
   * for this specific model type is found.
   */
  adapter: ORMAdapter;

  /**
   * The id of the record
   */
  get id(): any {
    return this.adapter.idFor(this);
  }
  set id(value: any) {
    this.adapter.setId(this, value);
  }

  /**
   * The underlying ORM adapter record. An opaque value to Denali, handled entirely by the ORM
   * adapter.
   */
  record: any = null;

  /**
   * Creates an instance of Model. We don't use init() here because we want do some sleight of hand
   * and actually return a Proxy of the ORM's record, rather than a true Model instance.
   */
  constructor() {
    super();
    return new Proxy(this, {
      get(model: Model, property: string): any {
        if (typeof property === 'string') {
          // Return the attribute value if that's what is requested
          let descriptor = (<any>model.constructor)[property];
          if (descriptor && descriptor.isAttribute) {
            return model.adapter.getAttribute(model, property);
          }
          // Forward relationship related methods to their generic counterparts
          let relatedMethodParts = property.match(/^(get|set|add|remove)(\w+)/);
          if (relatedMethodParts) {
            let [ , operation, relationshipName ] = relatedMethodParts;
            relationshipName = lowerFirst(relationshipName);
            descriptor = (<any>model.constructor)[relationshipName] || (<any>model.constructor)[pluralize(relationshipName)];
            if (descriptor && descriptor.isRelationship) {
              return model[`${ operation }Related`].bind(model, relationshipName);
            }
          }
        }
        // We double check getAttribute here because it's possible the user supplied some non-attribute
        // properties during creation. If so, these were dumped into the `buildRecord` method, which
        // may have bulk assigned them to the underlying record instance (if the ORM allows it). So
        // we defer there first, just in case. This is a nasty hack - we need to fix how we handle
        // this.
        return model.adapter.getAttribute(model, property) || model[property];
      },

      set(model: Model, property: string, value: any): boolean {
        // Set attribute values
        let descriptor = <RelationshipDescriptor & AttributeDescriptor>(<any>model.constructor)[property];
        if (descriptor && descriptor.isAttribute) {
          return model.adapter.setAttribute(model, property, value);
        }
        // Otherwise just set the model property directly
        model[property] = value;
        return true;
      },

      deleteProperty(model: Model, property: string): boolean {
        // Delete the attribute
        let descriptor = (<any>model.constructor)[property];
        if (descriptor && descriptor.isAttribute) {
          return model.adapter.deleteAttribute(model, property);
        }
        // Otherwise just delete the model property directly
        return delete model[property];
      }
    });
  }

  init(data: any, options: any) {
    super.init(...arguments);
    this.adapter = this.container.lookup(`orm-adapter:${ this.type }`) || this.container.lookup('orm-adapter:application');
    this.record = this.adapter.buildRecord(this.type, data, options);
  }

  /**
   * Persist this model.
   */
  async save(options?: any): Promise<Model> {
    debug(`saving ${ this.type }`);
    await this.adapter.saveRecord(this, options);
    return this;
  }

  /**
   * Delete this model.
   */
  async delete(options?: any): Promise<void> {
    await this.adapter.deleteRecord(this, options);
  }

  /**
   * Returns the related record(s) for the given relationship.
   */
  async getRelated(relationshipName: string, query?: any, options?: any): Promise<Model|Model[]> {
    let descriptor = (<any>this.constructor)[relationshipName];
    assert(descriptor && descriptor.isRelationship, `You tried to fetch related ${ relationshipName }, but no such relationship exists on ${ this.type }`);
    if (descriptor.mode === 'hasOne') {
      options = query;
      query = null;
    }
    let results = await this.adapter.getRelated(this, relationshipName, descriptor, query, options);
    let RelatedModel = this.container.factoryFor<Model>(`model:${ descriptor.type }`);
    if (!Array.isArray(results)) {
      assert(descriptor.mode === 'hasOne', 'The ORM adapter returned an array for a hasOne relationship - it should return either the record or null');
      return results ? RelatedModel.create(this.container, results) : null;
    }
    return results.map((record) => RelatedModel.create(this.container, record));
  }

  /**
   * Replaces the related records for the given relationship with the supplied related records.
   */
  async setRelated(relationshipName: string, relatedModels: Model|Model[], options?: any): Promise<void> {
    let descriptor = (<any>this.constructor)[relationshipName];
    await this.adapter.setRelated(this, relationshipName, descriptor, relatedModels, options);
  }

  /**
   * Add a related record to a hasMany relationship.
   */
  async addRelated(relationshipName: string, relatedModel: Model, options?: any): Promise<void> {
    let descriptor = (<any>this.constructor)[pluralize(relationshipName)];
    await this.adapter.addRelated(this, relationshipName, descriptor, relatedModel, options);
  }

  /**
   * Remove the given record from the hasMany relationship
   */
  async removeRelated(relationshipName: string, relatedModel: Model, options?: any): Promise<void> {
    let descriptor = (<any>this.constructor)[pluralize(relationshipName)];
    await this.adapter.removeRelated(this, relationshipName, descriptor, relatedModel, options);
  }

  /**
   * Return an human-friendly string representing this Model instance, with a summary of it's
   * attributes
   */
  inspect(): string {
    let attributesSummary: string[] = this.mapAttributes((value, attributeName) => {
      return `${ attributeName }=${ JSON.stringify(value) }`;
    });
    return `<${ startCase(this.type) }:${ this.id == null ? '-new-' : this.id } ${ attributesSummary.join(', ') }>`;
  }

  /**
   * Return an human-friendly string representing this Model instance
   */
  toString(): string {
    return `<${ startCase(this.type) }:${ this.id == null ? '-new-' : this.id }>`;
  }

  /**
   * Call the supplied callback function for each attribute on this model, passing in the attribute
   * name and attribute instance.
   */
  mapAttributes<T>(fn: (value: any, attributeName: string) => T): T[] {
    let meta = this.container.metaFor(this.constructor);
    if (meta.attributesCache == null) {
      meta.attributesCache = [];
      let klass = <any>this.constructor;
      for (let key in klass) {
        if (klass[key] && klass[key].isAttribute) {
          meta.attributesCache.push(key);
        }
      }
    }
    return meta.attributesCache.map((attributeName: string) => {
      return fn((<any>this)[attributeName], attributeName);
    });
  }

  /**
   * Call the supplied callback function for each relationship on this model, passing in the
   * relationship name and relationship instance.
   */
  mapRelationships<T>(fn: (descriptor: RelationshipDescriptor, relationshipName: string) => T): T[] {
    let meta = this.container.metaFor(this.constructor);
    let klass = <any>this.constructor;
    if (meta.relationshipsCache == null) {
      meta.relationshipsCache = [];
      for (let key in klass) {
        if (klass[key] && klass[key].isRelationship) {
          meta.relationshipsCache.push(key);
        }
      }
    }
    return meta.relationshipsCache.map((relationshipName: string) => {
      return fn((<any>this)[relationshipName], relationshipName);
    });
  }

}

