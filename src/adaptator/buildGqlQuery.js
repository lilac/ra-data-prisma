import { GET_LIST, GET_MANY, GET_MANY_REFERENCE, DELETE } from 'react-admin';
import { QUERY_TYPES } from 'ra-data-graphql';
import { TypeKind, parse } from 'graphql';
import get from 'lodash/get';

import { encodeQuery, encodeMutation } from './utils/graphqlify';
import getFinalType from './utils/getFinalType';
import isList from './utils/isList';
import isRequired from './utils/isRequired';

export const buildFields = introspectionResults => fields => {
  return fields.reduce((acc, field) => {
    const type = getFinalType(field.type);

    if (type.name.startsWith('_')) {
      return acc;
    }

    if (type.kind !== TypeKind.OBJECT) {
      return { ...acc, [field.name]: {} };
    }

    const linkedResource = introspectionResults.resources.find(r => r.type.name === type.name);

    if (linkedResource) {
      return { ...acc, [field.name]: { fields: { id: {} } } };
    }

    const linkedType = introspectionResults.types.find(t => t.name === type.name);

    if (linkedType) {
      return {
        ...acc,
        [field.name]: {
          fields: buildFields(introspectionResults)(linkedType.fields)
        }
      };
    }

    // NOTE: We might have to handle linked types which are not resources but will have to be careful about
    // ending with endless circular dependencies
    return acc;
  }, {});
};

export const getArgType = arg => {
  const type = getFinalType(arg.type);
  const required = isRequired(arg.type);
  const list = isList(arg.type);

  return `${list ? '[' : ''}${type.name}${list ? '!]' : ''}${required ? '!' : ''}`;
};

export const buildArgs = (query, variables) => {
  if (query.args.length === 0) {
    return {};
  }

  const validVariables = Object.keys(variables).filter(k => typeof variables[k] !== 'undefined');
  let args = query.args
    .filter(a => validVariables.includes(a.name))
    .reduce((acc, arg) => ({ ...acc, [`${arg.name}`]: `$${arg.name}` }), {});

  return args;
};

export const buildApolloArgs = (query, variables) => {
  if (query.args.length === 0) {
    return {};
  }

  const validVariables = Object.keys(variables).filter(k => typeof variables[k] !== 'undefined');

  let args = query.args.filter(a => validVariables.includes(a.name)).reduce((acc, arg) => {
    return { ...acc, [`$${arg.name}`]: getArgType(arg) };
  }, {});

  return args;
};

const getOverridenQuery = (overrideQueriesByFragment, resourceName, aorFetchType) => {
  return get(overrideQueriesByFragment, `${resourceName}.${aorFetchType}`);
};

const isQueryOverriden = (overrideQueriesByFragment, resourceName, aorFetchType) => {
  return !!getOverridenQuery(overrideQueriesByFragment, resourceName, aorFetchType);
};

const convertSelectionSetToGraphqlifyFields = selectionSet => {
  return selectionSet.selections.reduce((acc, selection) => {
    if (!selection.selectionSet) {
      return { ...acc, [selection.name.value]: {} };
    }

    return {
      ...acc,
      [selection.name.value]: {
        fields: convertSelectionSetToGraphqlifyFields(selection.selectionSet)
      }
    };
  }, {});
};

const buildFieldsFromFragment = fragment => {
  let parsedFragment = {};

  if (typeof fragment === 'object' && fragment.kind === 'Document') {
    parsedFragment = fragment;
  } else if (typeof fragment === 'string') {
    parsedFragment = parse(fragment);
  }

  return convertSelectionSetToGraphqlifyFields(parsedFragment.definitions[0].selectionSet);
};

export default introspectionResults => (
  resource,
  aorFetchType,
  queryType,
  variables,
  overrideQueriesByFragment
) => {
  const apolloArgs = buildApolloArgs(queryType, variables);
  const args = buildArgs(queryType, variables);
  const fields = isQueryOverriden(overrideQueriesByFragment, resource.type.name, aorFetchType)
    ? buildFieldsFromFragment(
        getOverridenQuery(overrideQueriesByFragment, resource.type.name, aorFetchType)
      )
    : buildFields(introspectionResults)(resource.type.fields);

  if (
    aorFetchType === GET_LIST ||
    aorFetchType === GET_MANY ||
    aorFetchType === GET_MANY_REFERENCE
  ) {
    const result = encodeQuery(queryType.name, {
      params: apolloArgs,
      fields: {
        items: {
          field: queryType.name,
          params: args,
          fields
        },
        total: {
          field: `${queryType.name}Connection`,
          params: args,
          fields: {
            aggregate: {
              fields: { count: {} }
            }
          }
        }
      }
    });

    return result;
  }

  if (aorFetchType === DELETE) {
    return encodeMutation(queryType.name, {
      params: apolloArgs,
      fields: {
        data: {
          field: queryType.name,
          params: args,
          fields: { id: {} }
        }
      }
    });
  }

  const query = {
    params: apolloArgs,
    fields: {
      data: {
        field: queryType.name,
        params: args,
        fields
      }
    }
  };

  return QUERY_TYPES.includes(aorFetchType)
    ? encodeQuery(queryType.name, query)
    : encodeMutation(queryType.name, query);
};
